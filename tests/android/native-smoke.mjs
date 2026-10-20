// Native app smoke run on an emulator (or a phone over USB) against a throwaway server with demo data.
// Prerequisites: the release APK of mobile/ is installed (adb install -r ...), an emulator is running.
// Run from the repository root: node tests/android/native-smoke.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDetailFlowServer } from '../../server/app.mjs';
import { back, find, launch, screenshot, sleep, tap, tapNode, type, waitFor } from './native-ui.mjs';

const PORT = 4180;
const out = resolve('artifacts/native');
mkdirSync(out, { recursive: true });
const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
await new Promise((done) => server.listen(PORT, '0.0.0.0', done));
const api = (path, init = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...init.headers } });
const step = (name) => console.log(`· ${name}`);

// An approved order waiting for a master (the same steps as the server tests).
async function approvedOrder() {
  const booking = await (await api('/api/bookings', { method: 'POST', headers: { 'idempotency-key': `native-smoke-${Date.now()}` }, body: JSON.stringify({
    customerId: 'cust_alexey', vehicleId: 'veh_camry', channel: 'in_person', startAt: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + 'T12:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
  }) })).json();
  const order = await (await api('/api/orders', { method: 'POST', body: JSON.stringify({ bookingId: booking.id }) })).json();
  await api(`/api/orders/${order.id}/intake`, { method: 'PUT', body: JSON.stringify({ conditionSummary: 'Автомобиль принят', findings: [], recommendations: [] }) });
  const estimate = await (await api(`/api/orders/${order.id}/estimates`, { method: 'POST', body: JSON.stringify({ lines: [
    { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 },
    { sourceType: 'recommendation', name: 'Защита кузова', amountMinor: 90000, durationMinutes: 25 }
  ] }) })).json();
  await api(`/api/orders/${order.id}/estimate-approvals`, { method: 'POST', body: JSON.stringify({ estimateVersionId: estimate.id, decision: 'APPROVED', method: 'in_person', source: 'native_smoke', responsible: 'Анна' }) });
  return order.id;
}

try {
  const workOrderId = await approvedOrder();

  step('first launch asks for the server');
  await launch('ru.detailflow.app', { clear: true });
  await waitFor('Адрес сервера');
  await tap(/192\.168\.1\.60:4173/);
  await type(`10.0.2.2:${PORT}`);
  screenshot(resolve(out, '01-server.png'));
  await tap('Подключиться');

  step('sign-in offers the messenger, an access code and the demo');
  await waitFor('Вход в DetailFlow');
  screenshot(resolve(out, '02-login.png'));
  await tap('Демо-режим');

  step('orders open on the tabs');
  await waitFor(/^Все$/, { timeout: 20_000 });
  await sleep(800);
  screenshot(resolve(out, '03-orders.png'));
  for (const label of ['Статистика', 'Записи', 'Новая', 'Заказы', 'Профиль']) assert.ok(find(label).length, `tab ${label}`);

  const orders = (await (await api('/api/orders?limit=50')).json()).items;
  if (orders.length) {
    step('an order opens in its own screen');
    await tap(orders[0].vehicle.plate);
    await waitFor(/^Приёмка$/);
    await sleep(500);
    screenshot(resolve(out, '04-order.png'));
    back();
    await waitFor(/^Все$/);
  }

  step('stage 2: assign a master, start, tick, pause, resume, complete');
  await tap(/Согласован$/);
  await waitFor('Назначить мастера');
  screenshot(resolve(out, '08-assign.png'));
  await tap(/^в работе: \d+$/);
  await tap('Начать работу');
  await tap('Бережная мойка');
  await waitFor(/^1\/2$/);
  await tap('Пауза');
  await tap('Ждём сушки');
  await tap('Поставить паузу');
  await waitFor(/^Пауза: Ждём сушки/);
  screenshot(resolve(out, '09-paused.png'));
  await tap('Продолжить работу');
  await tap('Защита кузова');
  await waitFor(/^2\/2$/);
  screenshot(resolve(out, '10-checklist-done.png'));
  await tap('Завершить');
  await waitFor('Завершить работы?');
  await tapNode(find(/^(Завершить|ЗАВЕРШИТЬ)$/).at(-1));
  await sleep(1500);
  const finished = await (await api(`/api/orders/${workOrderId}`)).json();
  assert.equal(finished.status, 'READY', 'the order goes to handover');
  assert.equal(finished.work.operations.every((operation) => operation.status === 'DONE'), true);
  back();
  await waitFor(/^Все$/);

  step('profile: demo sign-out returns to sign-in');
  await tap('Профиль');
  await waitFor('Рабочий центр');
  screenshot(resolve(out, '05-profile.png'));
  assert.equal(find('Удалить аккаунт').length, 0, 'a demo session has no account to delete');
  await tap('Выйти из демо-режима');
  await waitFor('Вход в DetailFlow');

  step('an employee signs in with an access code and deletes the account');
  const created = await (await api('/api/tenants/current/team', { method: 'POST', body: JSON.stringify({ displayName: 'Мария Орлова', roles: ['intake'] }) })).json();
  await tap(/^df_/);
  await type(created.accessToken);
  back(); // hide the keyboard
  await tap('Войти по коду');
  await waitFor(/^Все$/, { timeout: 20_000 });
  await tap('Профиль');
  await waitFor('Мария Орлова');
  await tap('Удалить аккаунт');
  await waitFor('Удалить навсегда');
  screenshot(resolve(out, '06-delete-confirm.png'));
  await tap('Удалить навсегда');
  await waitFor('Вход в DetailFlow');
  const after = await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers: { authorization: `Bearer ${created.accessToken}` } });
  assert.equal(after.status, 401, 'the access code no longer works');
  screenshot(resolve(out, '07-after-delete.png'));
  console.log('native smoke: ok');
} finally {
  await new Promise((done) => server.close(done));
}
