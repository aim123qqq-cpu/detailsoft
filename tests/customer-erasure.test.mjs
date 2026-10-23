import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { DetailFlowRepository } from '../server/repository.mjs';

test('a customer\'s data is destroyed on request; the center keeps anonymous work records', () => {
  const db = openDatabase(':memory:', { seed: true });
  const repository = new DetailFlowRepository(db);
  const tenant = 'tenant_demo';
  const order = db.prepare('SELECT id, vehicle_id FROM orders WHERE tenant_id = ? AND customer_id = ?').get(tenant, 'cust_alexey');
  const { phone_normalized: phone } = db.prepare('SELECT phone_normalized FROM customers WHERE id = ?').get('cust_alexey');
  const { plate_display: plate } = db.prepare('SELECT plate_display FROM vehicles WHERE id = ?').get(order.vehicle_id);

  // Active work comes first: an open lead blocks the erasure.
  assert.equal(repository.eraseCustomer(tenant, 'cust_alexey', 'Анна').kind, 'active_work');
  db.prepare(`UPDATE leads SET status = 'LOST' WHERE tenant_id = ? AND customer_id = ?`).run(tenant, 'cust_alexey');

  // A signed act and a photo of the car exist for the order.
  db.prepare(`INSERT INTO order_documents (id, tenant_id, order_id, document_type, sequence, number, content_json, signer_name, signature_data_url, actor_name)
    VALUES ('doc_1', ?, ?, 'intake_act', 900, 'АП-000900', ?, 'Алексей Морозов', 'data:image/png;base64,AAAA', 'Анна')`)
    .run(tenant, order.id, JSON.stringify({ customer: { name: 'Алексей Морозов', phoneDisplay: '+7 913 000-00-00' }, vehicle: { make: 'Mazda', plate }, statement: 'Состояние подтверждаю' }));
  db.prepare(`INSERT INTO order_photos (id, tenant_id, order_id, kind, zone, mime_type, data_url) VALUES ('ph_1', ?, ?, 'intake', 'Кузов', 'image/jpeg', 'data:image/jpeg;base64,AAAA')`).run(tenant, order.id);

  const result = repository.eraseCustomer(tenant, 'cust_alexey', 'Анна');
  assert.equal(result.kind, 'erased');
  assert.equal(result.documents, 1);
  assert.ok(result.photos >= 1);

  const customer = db.prepare('SELECT name, phone_display, phone_normalized, archived_at FROM customers WHERE id = ?').get('cust_alexey');
  assert.equal(customer.name, 'Удалённый клиент');
  assert.equal(customer.phone_display, '');
  assert.notEqual(customer.phone_normalized, phone);
  assert.ok(customer.archived_at, 'out of every list');
  assert.equal(repository.searchCustomers(tenant, phone.slice(-7), true).length, 0, 'not found by the old phone');
  assert.equal(db.prepare('SELECT plate_display FROM vehicles WHERE id = ?').get(order.vehicle_id).plate_display, '—');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM order_photos WHERE order_id = ?').get(order.id).count, 0);

  const document = db.prepare('SELECT content_json, signer_name, signature_data_url FROM order_documents WHERE id = ?').get('doc_1');
  const content = JSON.parse(document.content_json);
  assert.equal(content.customer.name, 'Удалённый клиент');
  assert.equal(content.vehicle.plate, '—');
  assert.equal(content.statement, 'Состояние подтверждаю', 'the work record stays');
  assert.equal(document.signer_name, null);
  assert.equal(document.signature_data_url, null);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM leads WHERE tenant_id = ?').all(tenant)), new RegExp(phone));
  assert.equal(db.prepare('SELECT orders FROM customer_erasures WHERE customer_id = ?').get('cust_alexey').orders, 1, 'the erasure is recorded');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders WHERE customer_id = ?').get('cust_alexey').count, 1, 'the order stays');
  assert.equal(repository.reactivateCustomer(tenant, 'cust_alexey', 'Анна').kind, 'erased', 'an erased customer cannot be brought back');
  db.close();
});
