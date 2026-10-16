import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

let server;
let baseUrl;
let orderId;
const photoDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const signatureDataUrl = photoDataUrl;

before(async () => {
  server = createDetailFlowServer({
    databasePath: ':memory:',
    seed: true,
    authTokens: new Map([
      ['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin', 'intake', 'master'] }],
      ['intake-only-token', { tenantId: 'tenant_demo', displayName: 'Ирина', roles: ['intake'] }],
      ['master-only-token', { tenantId: 'tenant_demo', displayName: 'Дмитрий', roles: ['master'] }],
      ['other-session-token', { tenantId: 'tenant_other', displayName: 'Олег', roles: ['admin'] }]
    ])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const booking = await (await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'documents-booking' }, body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'in_person',
      startAt: '2026-12-28T12:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    }
  })).json();
  orderId = (await (await api('/api/orders', { method: 'POST', body: { bookingId: booking.id } })).json()).id;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function api(path, { token = 'demo-session-token', method = 'GET', body, headers = {} } = {}) {
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

function saveIntake(note) {
  return api(`/api/orders/${orderId}/intake`, { method: 'PUT', body: {
    conditionSummary: 'Автомобиль принят при клиенте',
    findings: [{ zone: 'Переднее крыло', severity: 'MEDIUM', note }],
    recommendations: [{ title: 'Локальная защита скола', reason: 'Снизит риск коррозии', priority: 'RECOMMENDED' }]
  } });
}

function issue(body, token) {
  return api(`/api/orders/${orderId}/documents`, { method: 'POST', body, token });
}

test('intake act is unavailable before the intake is saved and preview never stores a document', async () => {
  const early = await api(`/api/orders/${orderId}/documents/preview?type=intake_act`);
  assert.equal(early.status, 409);
  assert.equal((await early.json()).error.code, 'document_not_available');

  await api(`/api/orders/${orderId}/photos`, {
    method: 'POST', body: { phase: 'intake', kind: 'intake', zone: 'Кузов', dataUrl: photoDataUrl }
  });
  assert.equal((await saveIntake('Скол ЛКП справа')).status, 200);

  const preview = await api(`/api/orders/${orderId}/documents/preview?type=intake_act`);
  assert.equal(preview.status, 200);
  const { type, content } = await preview.json();
  assert.equal(type, 'intake_act');
  assert.equal(content.customer.name, 'Алексей Морозов');
  assert.equal(content.vehicle.plate, 'А123АА 55');
  assert.deepEqual(content.intake.findings.map((finding) => finding.note), ['Скол ЛКП справа']);
  assert.equal(content.intake.photoCount, 1);
  assert.ok(content.statement.length > 20);

  const listed = await (await api(`/api/orders/${orderId}/documents`)).json();
  assert.deepEqual(listed.items, []);
});

test('a signed intake act freezes its content, gets a tenant number and is audited', async () => {
  const response = await issue({ type: 'intake_act', signerName: '  Алексей Морозов ', signatureDataUrl });
  assert.equal(response.status, 201);
  const document = await response.json();
  assert.equal(document.type, 'intake_act');
  assert.equal(document.number, 'АП-000001');
  assert.equal(document.signed, true);
  assert.equal(document.signerName, 'Алексей Морозов');
  assert.ok(document.signedAt);
  assert.equal(document.actorName, 'Анна');
  assert.equal(document.signatureDataUrl, signatureDataUrl);
  assert.deepEqual(document.content.intake.findings.map((finding) => finding.note), ['Скол ЛКП справа']);

  const listed = (await (await api(`/api/orders/${orderId}/documents`)).json()).items;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].current, true);
  assert.equal(listed[0].outdated, false);
  assert.equal(listed[0].signatureDataUrl, undefined, 'the list does not ship signature images');

  const order = await (await api(`/api/orders/${orderId}`)).json();
  assert.deepEqual(order.documents.map((item) => item.number), ['АП-000001']);
  assert.ok(order.auditTrail.some((event) => event.eventType === 'DOCUMENT_ISSUED' && event.metadata.number === 'АП-000001'));
});

test('a repeated inspection marks the signed act outdated without rewriting it', async () => {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await saveIntake('Скол ЛКП справа и царапина на двери')).status, 200);
  const listed = (await (await api(`/api/orders/${orderId}/documents`)).json()).items;
  assert.equal(listed[0].outdated, true);

  const original = await (await api(`/api/orders/${orderId}/documents/${listed[0].id}`)).json();
  assert.deepEqual(original.content.intake.findings.map((finding) => finding.note), ['Скол ЛКП справа']);
  assert.equal(original.signerName, 'Алексей Морозов');

  const unsigned = await issue({ type: 'intake_act' });
  assert.equal(unsigned.status, 201);
  const second = await unsigned.json();
  assert.equal(second.number, 'АП-000002');
  assert.equal(second.signed, false);
  assert.equal(second.signerName, null);
  assert.deepEqual(second.content.intake.findings.map((finding) => finding.note), ['Скол ЛКП справа и царапина на двери']);

  const after = (await (await api(`/api/orders/${orderId}/documents`)).json()).items;
  assert.deepEqual(after.map((item) => [item.number, item.current, item.outdated]), [
    ['АП-000002', true, false],
    ['АП-000001', false, true]
  ]);
});

test('handover act is issued only for a closed order and lists the approved works without payments', async () => {
  const early = await issue({ type: 'handover_act' });
  assert.equal(early.status, 409);
  assert.equal((await early.json()).error.code, 'document_not_available');

  const estimate = await (await api(`/api/orders/${orderId}/estimates`, { method: 'POST', body: { lines: [
    { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 },
    { sourceType: 'recommendation', name: 'Локальная защита скола', amountMinor: 90000, durationMinutes: 25 }
  ] } })).json();
  assert.equal((await api(`/api/orders/${orderId}/estimate-approvals`, { method: 'POST', body: {
    estimateVersionId: estimate.id, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна'
  } })).status, 200);
  await api(`/api/orders/${orderId}/assignment`, { method: 'PUT', body: { masterName: 'Дмитрий Соколов' } });
  const started = await (await api(`/api/orders/${orderId}/work/start`, { method: 'POST', body: {} })).json();
  for (const operation of started.work.operations) {
    await api(`/api/orders/${orderId}/work/operations/${operation.id}`, { method: 'PATCH', body: { status: 'DONE', note: '' } });
  }
  assert.equal((await (await api(`/api/orders/${orderId}/work/complete`, { method: 'POST', body: {} })).json()).status, 'READY');
  await api(`/api/orders/${orderId}/photos`, {
    method: 'POST', body: { phase: 'result', kind: 'intake', zone: 'Результат работ', dataUrl: photoDataUrl }
  });
  const closed = await api(`/api/orders/${orderId}/handover`, { method: 'POST', body: {
    responsible: 'Анна', note: 'Клиент принял автомобиль', customerAccepted: true, completenessChecked: true
  } });
  assert.equal(closed.status, 200, 'closing does not require any signature');

  const intakeOnly = await issue({ type: 'handover_act' }, 'intake-only-token');
  assert.equal(intakeOnly.status, 403);

  const response = await issue({ type: 'handover_act', signerName: 'Алексей Морозов', signatureDataUrl });
  assert.equal(response.status, 201);
  const document = await response.json();
  assert.equal(document.number, 'АВ-000001');
  assert.deepEqual(document.content.works.map((work) => work.name), ['Бережная мойка', 'Локальная защита скола']);
  assert.equal(document.content.estimate.totalAmountMinor, 230000);
  assert.equal(document.content.estimate.version, 1);
  assert.equal(document.content.handover.responsible, 'Анна');
  assert.equal(document.content.photos.result, 1);
  assert.doesNotMatch(JSON.stringify(document.content), /payment|paid/i);

  const historical = await api('/api/orders/order_history_1/documents/preview?type=handover_act');
  assert.equal(historical.status, 200, 'a historical closed order without a handover record still renders');
  const historicalContent = (await historical.json()).content;
  assert.equal(historicalContent.handover, null);
  assert.deepEqual(historicalContent.works, []);

  const intakeStillAvailable = await issue({ type: 'intake_act' }, 'intake-only-token');
  assert.equal(intakeStillAvailable.status, 201, 'an intake act can still be printed after closing');
  assert.equal((await intakeStillAvailable.json()).number, 'АП-000003');
});

test('document input and signatures are validated without storing anything', async () => {
  const before = (await (await api(`/api/orders/${orderId}/documents`)).json()).items.length;
  const oversized = `data:image/png;base64,${Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(210 * 1024)
  ]).toString('base64')}`;
  const cases = [
    {},
    { type: 'payment_receipt' },
    { type: 'intake_act', signatureDataUrl },
    { type: 'intake_act', signerName: 'Алексей Морозов' },
    { type: 'intake_act', signerName: 'А', signatureDataUrl },
    { type: 'intake_act', signerName: 'Алексей Морозов', signatureDataUrl: 'data:image/jpeg;base64,/9j/4AAQ' },
    { type: 'intake_act', signerName: 'Алексей Морозов', signatureDataUrl: 'data:image/png;base64,aGVsbG8=' },
    { type: 'intake_act', signerName: 'Алексей Морозов', signatureDataUrl: oversized },
    { type: 'intake_act', content: { forged: true } }
  ];
  for (const body of cases) {
    const response = await issue(body);
    assert.equal(response.status, 422, JSON.stringify(body).slice(0, 80));
    assert.equal((await response.json()).error.code, 'validation_error');
  }
  assert.equal((await api(`/api/orders/${orderId}/documents/preview?type=unknown`)).status, 422);
  assert.equal((await (await api(`/api/orders/${orderId}/documents`)).json()).items.length, before);
});

test('documents are tenant scoped and need intake or handover rights', async () => {
  const [first] = (await (await api(`/api/orders/${orderId}/documents`)).json()).items;
  assert.equal((await api(`/api/orders/${orderId}/documents`, { token: 'other-session-token' })).status, 404);
  assert.equal((await api(`/api/orders/${orderId}/documents/${first.id}`, { token: 'other-session-token' })).status, 404);
  assert.equal((await api(`/api/orders/${orderId}/documents/preview?type=intake_act`, { token: 'other-session-token' })).status, 404);
  assert.equal((await issue({ type: 'intake_act' }, 'other-session-token')).status, 404);
  assert.equal((await api(`/api/orders/${orderId}/documents/doc_missing`)).status, 404);

  assert.equal((await api(`/api/orders/${orderId}/documents`, { token: 'master-only-token' })).status, 403);
  assert.equal((await api(`/api/orders/${orderId}/documents/${first.id}`, { token: 'master-only-token' })).status, 403);
  assert.equal((await issue({ type: 'intake_act' }, 'master-only-token')).status, 403);
});
