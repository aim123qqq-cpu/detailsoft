import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';
import { buildDocumentContent, contractorLine } from '../src/shared/orderDocuments.ts';

test('the center fills in its requisites; they reach the session and the acts as the contractor', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = (path, init = {}) => fetch(`${baseUrl}${path}`, { ...init, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json' } });
  try {
    assert.deepEqual(await (await api('/api/tenants/current/requisites')).json(), { legalName: '', inn: '', ogrn: '', address: '', phone: '', warranty: '' });
    const wrong = await api('/api/tenants/current/requisites', { method: 'PUT', body: JSON.stringify({ inn: '123' }) });
    assert.equal(wrong.status, 422);
    assert.equal((await wrong.json()).error.field, 'inn');

    const saved = await (await api('/api/tenants/current/requisites', { method: 'PUT', body: JSON.stringify({
      legalName: '  ИП  Иванов Иван Иванович ', inn: '5501 2345 6789', ogrn: '320550000012345', address: 'Омск, ул. Ленина, 1', phone: '+7 913 000-00-00', warranty: '6 месяцев на покрытие'
    }) })).json();
    assert.equal(saved.legalName, 'ИП Иванов Иван Иванович');
    assert.equal(saved.inn, '550123456789', 'digits only');
    const session = await (await api('/api/session')).json();
    assert.equal(session.tenant.requisites.ogrn, '320550000012345', 'the phone builds acts offline from the session');

    assert.equal(contractorLine(saved), 'ИП Иванов Иван Иванович · ИНН 550123456789 · ОГРНИП 320550000012345 · Омск, ул. Ленина, 1 · +7 913 000-00-00');
    const order = { id: 'order_1', createdAt: '2026-10-22T10:00:00Z', status: 'CLOSED', currentEstimateVersionId: null, photos: [], intake: null,
      estimateVersions: [], approval: null, work: null, handover: null };
    const built = buildDocumentContent(order, { centerName: 'Детейлинг', requisites: saved,
      customer: { name: 'Пётр', phoneDisplay: '+7 900 000-00-00' }, vehicle: { make: 'Lada', model: 'Vesta', generation: null, plate: 'А001АА 55', color: 'серый' } }, 'handover_act');
    assert.equal(built.content.center.inn, '550123456789');
    assert.equal(built.content.warranty, '6 месяцев на покрытие');
    assert.match(built.content.statement, /не является кассовым чеком/);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
