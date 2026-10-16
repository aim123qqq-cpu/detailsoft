import test from 'node:test';
import assert from 'node:assert/strict';
import { canShareOrder, formatOrderShareText, shareText } from '../src/shareOrder.ts';

const estimate = {
  id: 'estimate_1', orderId: 'order_1', version: 2, totalAmountMinor: 230000, totalDurationMinutes: 60, createdAt: '2026-10-16T09:00:00.000Z',
  lines: [
    { id: 'l1', sourceType: 'service', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 },
    { id: 'l2', sourceType: 'recommendation', name: 'Защита скола', amountMinor: 90000, durationMinutes: 25 }
  ]
};
const closedOrder = {
  id: 'order_1', status: 'CLOSED', currentEstimateVersionId: 'estimate_1', estimateVersions: [estimate],
  approval: { estimateVersionId: 'estimate_1', decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна', decidedAt: '2026-10-16T09:10:00.000Z' },
  work: { status: 'COMPLETED', operations: [
    { id: 'w1', name: 'Бережная мойка', amountMinor: 140000, status: 'DONE' },
    { id: 'w2', name: 'Защита скола', amountMinor: 90000, status: 'DONE' }
  ] },
  handover: { responsible: 'Анна', note: 'Принято', handedOverAt: '2026-10-16T15:00:00.000Z' }
};
const vehicle = { make: 'Mazda', model: '3', generation: 'BL', plate: 'А123АА 55' };

test('share text lists the performed works and the approved total without phones or payments', () => {
  const text = formatOrderShareText({ centerName: 'DetailFlow Studio', order: closedOrder, vehicle });
  const lines = text.split('\n');
  assert.equal(lines[0], 'DetailFlow Studio — заказ-наряд');
  assert.equal(lines[1], 'Mazda 3 BL, А123АА 55');
  assert.match(lines[2], /^Выдан: 16 октября 2026/);
  assert.ok(lines.includes('• Бережная мойка — 1 400 ₽'));
  assert.ok(lines.includes('• Защита скола — 900 ₽'));
  assert.ok(lines.includes('Итого по согласованной смете v2: 2 300 ₽'));
  assert.doesNotMatch(text, /\+7|оплат|оплачен/i);
});

test('only closed orders with an estimate can be shared', () => {
  assert.equal(canShareOrder(closedOrder), true);
  assert.equal(canShareOrder({ ...closedOrder, status: 'READY' }), false);
  assert.equal(canShareOrder({ ...closedOrder, estimateVersions: [], currentEstimateVersionId: null, approval: null }), false);
});

test('share falls back from the share sheet to the clipboard and then to manual copy', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => Object.defineProperty(globalThis, 'navigator', original));
  const setNavigator = (value) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true });

  let shared = null;
  setNavigator({ share: async (data) => { shared = data; } });
  assert.equal(await shareText({ title: 'T', text: 'body' }), 'shared');
  assert.deepEqual(shared, { title: 'T', text: 'body' });

  setNavigator({ share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
  assert.equal(await shareText({ title: 'T', text: 'body' }), 'cancelled');

  let copied = null;
  setNavigator({ clipboard: { writeText: async (value) => { copied = value; } } });
  assert.equal(await shareText({ title: 'T', text: 'body' }), 'copied');
  assert.equal(copied, 'body');

  setNavigator({});
  assert.equal(await shareText({ title: 'T', text: 'body' }), 'manual');
});
