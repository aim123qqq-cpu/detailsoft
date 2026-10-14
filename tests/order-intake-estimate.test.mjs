import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

let server;
let baseUrl;
let bookingId;
let orderId;

before(async () => {
  server = createDetailFlowServer({ databasePath: ':memory:', seed: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  const booking = await api('/api/bookings', {
    method: 'POST',
    headers: { 'idempotency-key': 'order-flow-booking' },
    body: {
      customerId: 'cust_alexey',
      vehicleId: 'veh_mazda',
      channel: 'in_person',
      startAt: '2026-11-02T10:30:00+03:00',
      selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(booking.status, 201);
  bookingId = (await booking.json()).id;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function api(path, { tenant = 'tenant_demo', method = 'GET', body, headers = {} } = {}) {
  const token = tenant === 'tenant_other' ? 'other-session-token' : 'demo-session-token';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

test('a confirmed booking creates one tenant-scoped intake order', async () => {
  const created = await api('/api/orders', { method: 'POST', body: { bookingId } });
  assert.equal(created.status, 201);
  const order = await created.json();
  orderId = order.id;
  assert.equal(order.status, 'INTAKE');
  assert.equal(order.bookingId, bookingId);
  assert.equal(order.customerId, 'cust_alexey');
  assert.equal(order.vehicleId, 'veh_mazda');

  const replay = await api('/api/orders', { method: 'POST', body: { bookingId } });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).id, orderId);

  const foreign = await api(`/api/orders/${orderId}`, { tenant: 'tenant_other' });
  assert.equal(foreign.status, 404);
});

test('intake photos are validated, tenant scoped and persisted with their inspection zone', async () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const uploaded = await api(`/api/orders/${orderId}/photos`, {
    method: 'POST',
    body: { kind: 'defect', zone: 'Переднее крыло', dataUrl }
  });
  assert.equal(uploaded.status, 201);
  const photo = await uploaded.json();
  assert.equal(photo.kind, 'defect');
  assert.equal(photo.zone, 'Переднее крыло');
  assert.equal(photo.mimeType, 'image/png');
  assert.equal(photo.dataUrl, dataUrl);

  const order = await (await api(`/api/orders/${orderId}`)).json();
  assert.equal(order.photos.length, 1);
  assert.equal(order.photos[0].id, photo.id);
  assert.ok(order.auditTrail.some((event) => event.eventType === 'INTAKE_PHOTO_ADDED'));

  const foreign = await api(`/api/orders/${orderId}/photos`, {
    tenant: 'tenant_other', method: 'POST', body: { kind: 'intake', zone: 'Кузов', dataUrl }
  });
  assert.equal(foreign.status, 404);

  const unsafe = await api(`/api/orders/${orderId}/photos`, {
    method: 'POST', body: { kind: 'intake', zone: 'Кузов', dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }
  });
  assert.equal(unsafe.status, 422);
});

test('intake stores structured findings and recommendations and advances the order', async () => {
  const response = await api(`/api/orders/${orderId}/intake`, {
    method: 'PUT',
    body: {
      conditionSummary: 'Кузов сухой, автомобиль принят при клиенте',
      findings: [
        { zone: 'Передний бампер', severity: 'MEDIUM', note: 'Скол справа' },
        { zone: 'Капот', severity: 'LOW', note: 'Следы реагента' }
      ],
      recommendations: [
        { title: 'Локальная защита', reason: 'Снизит риск коррозии скола', priority: 'RECOMMENDED' }
      ]
    }
  });
  assert.equal(response.status, 200);
  const order = await response.json();
  assert.equal(order.status, 'ESTIMATE_DRAFT');
  assert.equal(order.intake.findings.length, 2);
  assert.equal(order.intake.recommendations[0].title, 'Локальная защита');
  assert.ok(order.auditTrail.some((event) => event.eventType === 'INTAKE_COMPLETED'));
});

test('estimate versions are immutable snapshots with server-calculated totals', async () => {
  const first = await api(`/api/orders/${orderId}/estimates`, {
    method: 'POST',
    body: {
      lines: [
        { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 },
        { sourceType: 'recommendation', name: 'Локальная защита', amountMinor: 90000, durationMinutes: 25, reason: 'Согласовать после осмотра' }
      ]
    }
  });
  assert.equal(first.status, 201);
  const versionOne = await first.json();
  assert.equal(versionOne.version, 1);
  assert.equal(versionOne.totalAmountMinor, 230000);

  const second = await api(`/api/orders/${orderId}/estimates`, {
    method: 'POST',
    body: {
      lines: [{ sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 }]
    }
  });
  assert.equal(second.status, 201);
  const versionTwo = await second.json();
  assert.equal(versionTwo.version, 2);

  const order = await (await api(`/api/orders/${orderId}`)).json();
  assert.equal(order.estimateVersions.length, 2);
  assert.equal(order.estimateVersions[0].totalAmountMinor, 230000);
  assert.equal(order.currentEstimateVersionId, versionTwo.id);
});

test('only the current estimate can be approved and approval provenance is preserved', async () => {
  const orderBefore = await (await api(`/api/orders/${orderId}`)).json();
  const stale = orderBefore.estimateVersions[0];
  const current = orderBefore.estimateVersions[1];

  const staleApproval = await api(`/api/orders/${orderId}/estimate-approvals`, {
    method: 'POST',
    body: { estimateVersionId: stale.id, decision: 'APPROVED', method: 'in_person', source: 'manager_tablet', responsible: 'Анна' }
  });
  assert.equal(staleApproval.status, 409);
  assert.equal((await staleApproval.json()).error.code, 'stale_estimate');

  const approved = await api(`/api/orders/${orderId}/estimate-approvals`, {
    method: 'POST',
    body: { estimateVersionId: current.id, decision: 'APPROVED', method: 'in_person', source: 'manager_tablet', responsible: 'Анна' }
  });
  assert.equal(approved.status, 200);
  const order = await approved.json();
  assert.equal(order.status, 'APPROVED');
  assert.equal(order.approval.estimateVersionId, current.id);
  assert.equal(order.approval.method, 'in_person');
  assert.equal(order.approval.source, 'manager_tablet');
  assert.equal(order.approval.responsible, 'Анна');
  assert.match(order.approval.decidedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('approval validation rejects incomplete provenance', async () => {
  const response = await api(`/api/orders/${orderId}/estimate-approvals`, {
    method: 'POST',
    body: { estimateVersionId: 'missing', decision: 'APPROVED' }
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'validation_error');
});

test('approved order cannot be silently returned to intake', async () => {
  const response = await api(`/api/orders/${orderId}/intake`, {
    method: 'PUT',
    body: {
      conditionSummary: 'Попытка переписать закрытую приёмку',
      findings: [],
      recommendations: []
    }
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'invalid_order_state');

  const photo = await api(`/api/orders/${orderId}/photos`, {
    method: 'POST', body: {
      kind: 'intake', zone: 'Кузов',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    }
  });
  assert.equal(photo.status, 409);
  assert.equal((await photo.json()).error.code, 'invalid_order_state');
});
