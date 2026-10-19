import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';
import { BODY_TYPES, carLayout, findLayoutElement, normalizeBodyType } from '../src/shared/carLayouts.ts';

test('every body type numbers its elements 1..n with unique names and draws every exterior part', () => {
  for (const { code } of BODY_TYPES) {
    const layout = carLayout(code);
    const numbers = layout.elements.map((element) => element.number).sort((a, b) => a - b);
    assert.deepEqual(numbers, numbers.map((_, index) => index + 1), `${code}: numbers are consecutive`);
    assert.equal(new Set(layout.elements.map((element) => element.name)).size, layout.elements.length, `${code}: names are unique`);
    assert.equal(new Set(layout.elements.map((element) => element.id)).size, layout.elements.length, `${code}: ids are unique`);
    for (const element of layout.elements) {
      const exterior = ['body', 'glass', 'wheel', 'mirror'].includes(element.group);
      assert.equal(Boolean(element.d && element.label), exterior, `${code}: ${element.name} is drawn only when exterior`);
      if (element.label) assert.ok(element.label.x > 0 && element.label.x < layout.width && element.label.y > 0 && element.label.y < layout.height, `${code}: ${element.name} label inside the view`);
    }
    // The order an employee reads: bumper, hood and windshield come first.
    assert.deepEqual(['Передний бампер', 'Капот', 'Лобовое стекло'].map((name) => findLayoutElement(code, name)?.number), [1, 2, 3]);
  }
});

test('body types differ where real cars differ', () => {
  const ids = (code) => new Set(carLayout(code).elements.map((element) => element.id));
  assert.ok(ids('sedan').has('left-rear-door'));
  assert.ok(!ids('coupe').has('left-rear-door'), 'a coupe has one door per side');
  assert.ok(ids('van').has('right-sliding-door'));
  assert.ok(ids('pickup').has('bed') && ids('pickup').has('tailgate') && !ids('pickup').has('cargo'));
  assert.equal(findLayoutElement('sedan', 'Крышка багажника')?.group, 'body');
  assert.equal(findLayoutElement('wagon', 'Крышка багажника'), null);
  assert.equal(findLayoutElement('wagon', 'Дверь багажника')?.group, 'body');
  assert.ok(carLayout('van').height > carLayout('coupe').height, 'a van is longer than a coupe');
  assert.equal(normalizeBodyType('unknown'), 'sedan');
  assert.equal(normalizeBodyType(null), 'sedan');
});

let server;
let baseUrl;
let orderId;

before(async () => {
  server = createDetailFlowServer({
    databasePath: ':memory:',
    seed: true,
    authTokens: new Map([['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin', 'intake', 'master'] }]])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const booking = await (await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'body-type-booking' }, body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'in_person',
      startAt: '2026-12-29T12:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    }
  })).json();
  orderId = (await (await api('/api/orders', { method: 'POST', body: { bookingId: booking.id } })).json()).id;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function api(path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: 'Bearer demo-session-token', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
}

const intake = (extra) => api(`/api/orders/${orderId}/intake`, { method: 'PUT', body: {
  conditionSummary: 'Автомобиль принят при клиенте',
  findings: [
    { zone: 'Правое переднее крыло', severity: 'HIGH', note: 'Скол ЛКП' },
    { zone: 'Передние сиденья', severity: 'LOW', note: 'Пятно' },
    { zone: 'Кузов', severity: 'LOW', note: 'Старая запись без элемента' }
  ],
  recommendations: [],
  ...extra
} });

test('intake rejects an unknown body type', async () => {
  assert.equal((await intake({ bodyType: 'tank' })).status, 422);
});

test('the body type is stored with the intake and numbers the findings in the act', async () => {
  const saved = await intake({ bodyType: 'suv' });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).intake.bodyType, 'suv');
  assert.equal((await (await api(`/api/orders/${orderId}`)).json()).intake.bodyType, 'suv');

  const { content } = await (await api(`/api/orders/${orderId}/documents/preview?type=intake_act`)).json();
  assert.equal(content.intake.bodyType, 'suv');
  assert.deepEqual(content.intake.findings.map((finding) => finding.element), [
    findLayoutElement('suv', 'Правое переднее крыло').number,
    findLayoutElement('suv', 'Передние сиденья').number,
    null
  ]);
});

test('an intake re-saved by an older app without a body type keeps the stored one', async () => {
  const saved = await intake({});
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).intake.bodyType, 'suv');
  const { content } = await (await api(`/api/orders/${orderId}/documents/preview?type=intake_act`)).json();
  assert.equal(content.intake.bodyType, 'suv');
});
