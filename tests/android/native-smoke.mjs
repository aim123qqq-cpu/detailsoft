// Native app smoke run on an emulator (or a phone over USB) against a throwaway server with demo data.
// Prerequisites: the release APK of mobile/ is installed (adb install -r ...), an emulator is running.
// Run from the repository root: node tests/android/native-smoke.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDetailFlowServer } from '../../server/app.mjs';
import { carLayout } from '../../src/shared/carLayouts.ts';
import { adb, back, find, launch, screenshot, scrollTo, sleep, tap, tapAt, tapNode, type, waitFor } from './native-ui.mjs';

const PORT = 4180;
const out = resolve('artifacts/native');
mkdirSync(out, { recursive: true });
const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
await new Promise((done) => server.listen(PORT, '0.0.0.0', done));
const api = (path, init = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...init.headers } });
const step = (name) => console.log(`· ${name}`);

async function newOrder(vehicleId, hour) {
  const booking = await (await api('/api/bookings', { method: 'POST', headers: { 'idempotency-key': `native-smoke-${vehicleId}-${Date.now()}` }, body: JSON.stringify({
    customerId: 'cust_alexey', vehicleId, channel: 'in_person', startAt: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + `T${hour}:00:00+03:00`, selections: [{ type: 'service', id: 'service_wash' }]
  }) })).json();
  return (await api('/api/orders', { method: 'POST', body: JSON.stringify({ bookingId: booking.id }) })).json();
}

/** Takes a picture with the emulator's camera app (asks for the permission the first time). */
async function shoot() {
  const first = await waitFor(/^Shutter$|^While using the app$|^При использовании приложения$/, { timeout: 20_000 });
  if (first.desc !== 'Shutter') await tapNode(first);
  await sleep(1500);
  await tap('Shutter', { timeout: 20_000 });
  await tap('Done', { timeout: 20_000 });
}

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
  const intakeOrder = await newOrder('veh_mazda', 15);

  step('first launch asks for the server');
  await launch('ru.detailflow.app', { clear: true });
  await waitFor('Адрес сервера', { timeout: 45_000 });
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

  step('stage 3: intake on the diagram, findings, photos from the camera');
  await tap(/Приёмка$/);
  await tap('Провести приёмку');
  await waitFor('Тип кузова');
  await tap('Кроссовер');
  await sleep(600);
  const [diagram] = find('Схема автомобиля, вид сверху');
  const scale = (diagram.bounds.x2 - diagram.bounds.x1) / 200;
  const hood = carLayout('suv').elements.find((element) => element.id === 'hood');
  await tapAt(diagram.bounds.x1 + hood.label.x * scale, diagram.bounds.y1 + hood.label.y * scale);
  await waitFor('Капот');
  await tap('Скол ЛКП');
  await tap('Сильное');
  await tap('Фото');
  await shoot();
  await waitFor('Фото: Капот', { timeout: 30_000 });
  screenshot(resolve(out, '11-element.png'));
  await tap('Добавить замечание');
  await tapNode(await scrollTo('Передние сиденья'));
  await tap('Пятно');
  await tap('Добавить замечание');
  await tapNode(await scrollTo('Снять общий вид'));
  await shoot();
  await waitFor('2 из 19', { timeout: 30_000 });
  screenshot(resolve(out, '12-intake.png'));
  await tapNode(await scrollTo('Сохранить приёмку'));
  await waitFor(/^Смета$/, { timeout: 20_000 });
  await scrollTo('Изменить приёмку');
  await sleep(800);
  screenshot(resolve(out, '13-intake-saved.png'));
  const inspected = await (await api(`/api/orders/${intakeOrder.id}`)).json();
  assert.equal(inspected.status, 'ESTIMATE_DRAFT');
  assert.equal(inspected.intake.bodyType, 'suv');
  assert.deepEqual(inspected.intake.findings.map(({ zone, severity, note }) => [zone, severity, note]).sort(),
    [['Капот', 'HIGH', 'Скол ЛКП'], ['Передние сиденья', 'MEDIUM', 'Пятно']]);
  assert.deepEqual(inspected.photos.map((photo) => photo.zone).sort(), ['Капот', 'Общий вид']);
  assert.ok(inspected.photos.every((photo) => photo.dataUrl.startsWith('data:image/jpeg;base64,')));
  back();
  await waitFor(/^Все$/);

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
  await waitFor(/^Пауза$/); // resumed: the rows are enabled again
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

  step('stage 4: a booking for a known customer by phone');
  const bookingsOf = async (customerId) => (await (await api('/api/bookings?view=upcoming&limit=50')).json()).items.filter((item) => item.customer.id === customerId);
  await tap('Новая');
  await tap('+7 999 000-00-00');
  await type('79131234567');
  await waitFor('Алексей Морозов', { timeout: 20_000 });
  back(); // hide the keyboard
  await tap(/^В476РЕ 155,/);
  await waitFor('Бережная мойка', { timeout: 20_000 });
  adb('shell', 'input', 'swipe', '540', '1500', '540', '900', '400'); // above the price dock
  await sleep(600);
  await tap('Бережная мойка');
  await waitFor(/^[\d ]+ ₽ · /, { timeout: 20_000 }); // the preliminary total in the dock
  screenshot(resolve(out, '14-services.png'));
  await tap('Выбрать время');
  await tap('16:00', { timeout: 20_000 });
  screenshot(resolve(out, '15-schedule.png'));
  await tapNode(await scrollTo('Записать на 16:00'));
  await waitFor('Запись подтверждена', { timeout: 20_000 });
  screenshot(resolve(out, '16-booked.png'));
  const [booked] = (await bookingsOf('cust_alexey')).filter((item) => item.startAt.endsWith('T16:00:00+03:00'));
  assert.ok(booked, 'the booking is on the server at 16:00');
  await tap('Новая запись');

  step('stage 4: a new customer with a car typed in by hand, then intake right away');
  await tap('+7 999 000-00-00');
  await type('79990001122');
  await waitFor('Клиент не найден', { timeout: 20_000 });
  await tap('Например, Иван Петров');
  await type('Ivan Petrov');
  back();
  await tap('Создать клиента');
  await tap('Вручную', { timeout: 20_000 });
  await tap('Zeekr'); await type('Zeekr');
  await tap('001'); await type('001');
  back();
  await tap('Кроссовер');
  await tapNode(await scrollTo('А123АА 55'));
  await type('A777AA 77');
  back(); // the keyboard covers the colour field
  await tapNode(await scrollTo('графит')); await type('grey');
  back();
  await tapNode(await scrollTo('Сохранить и выбрать услуги'));
  await waitFor('Бережная мойка', { timeout: 20_000 });
  adb('shell', 'input', 'swipe', '540', '1500', '540', '900', '400'); // above the price dock
  await sleep(600);
  await tap('Бережная мойка');
  await waitFor(/^[\d ]+ ₽ · /, { timeout: 20_000 });
  await tap('Выбрать время');
  await tap('18:00', { timeout: 20_000 });
  await tapNode(await scrollTo('Записать на 18:00'));
  await waitFor('Запись подтверждена', { timeout: 20_000 });
  await tapNode(await scrollTo('Клиент на месте — начать приёмку'));
  await waitFor('Тип кузова', { timeout: 20_000 });
  await sleep(600);
  screenshot(resolve(out, '17-intake-from-booking.png'));
  const newCustomer = (await (await api('/api/customers?phone=79990001122')).json()).items[0];
  assert.equal(newCustomer.name, 'Ivan Petrov');
  assert.equal(newCustomer.vehicles[0].bodyType, 'suv');
  assert.equal(newCustomer.vehicles[0].plate, 'A777AA 77');
  const intakeOrders = (await (await api('/api/orders?limit=50')).json()).items.filter((item) => item.vehicle.plate === 'A777AA 77');
  assert.equal(intakeOrders.length, 1, 'the booking has its order');
  assert.equal(intakeOrders[0].status, 'INTAKE');
  back();
  await waitFor(/^Все$/, { timeout: 20_000 });

  step('stage 4: the schedule, moving and cancelling a booking, the customer card');
  await tap('Записи');
  await tap(/^16:00, Алексей Морозов/, { timeout: 20_000 });
  await tap('Перенести');
  await waitFor('Новое время');
  await tapNode(await scrollTo('17:00'));
  await tapNode(await scrollTo('Перенести запись'));
  await waitFor('Отменить запись', { timeout: 20_000 });
  assert.ok((await (await api(`/api/bookings/${booked.id}`)).json()).startAt.endsWith('T17:00:00+03:00'), 'moved to 17:00');
  screenshot(resolve(out, '18-booking.png'));
  await tapNode(await scrollTo('Отменить запись'));
  await waitFor('Отменить запись?');
  await tapNode(find(/^Отменить запись$/i).at(-1));
  await waitFor('Отменена', { timeout: 20_000 });
  assert.equal((await (await api(`/api/bookings/${booked.id}`)).json()).status, 'CANCELLED');
  for (let swipe = 0; swipe < 3; swipe += 1) adb('shell', 'input', 'swipe', '540', '900', '540', '1900', '300'); // back to the top
  await tap('Карточка клиента');
  await waitFor('Автомобили', { timeout: 20_000 });
  screenshot(resolve(out, '19-customer.png'));
  back();
  back();
  await tap('По дням', { timeout: 20_000 });
  await sleep(1200);
  screenshot(resolve(out, '20-day.png'));
  await tap('Заказы');
  await waitFor(/^Все$/);

  step('profile: demo sign-out returns to sign-in');
  await tap('Профиль');
  await waitFor('Рабочий центр');
  screenshot(resolve(out, '05-profile.png'));
  await tapNode(await scrollTo('Выйти из демо-режима'));
  // (checked by the server and the web test: a demo session has no account to delete)
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
  await tapNode(await scrollTo('Удалить аккаунт'));
  await waitFor(/^Удалить навсегда$/i);
  screenshot(resolve(out, '06-delete-confirm.png'));
  await tap(/^Удалить навсегда$/i);
  await waitFor('Вход в DetailFlow');
  const after = await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers: { authorization: `Bearer ${created.accessToken}` } });
  assert.equal(after.status, 401, 'the access code no longer works');
  screenshot(resolve(out, '07-after-delete.png'));
  console.log('native smoke: ok');
} finally {
  await new Promise((done) => server.close(done));
}
