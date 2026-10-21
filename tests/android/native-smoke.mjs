// Native app smoke run on an emulator (or a phone over USB) against a throwaway server with demo data.
// Prerequisites: the release APK of mobile/ is installed (adb install -r ...), an emulator is running.
// Run from the repository root: node tests/android/native-smoke.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { createDetailFlowServer } from '../../server/app.mjs';
import { carLayout } from '../../src/shared/carLayouts.ts';
import { adb, back, find, launch, screenshot, scrollTo, sleep, tap, tapAt, tapNode, type, waitFor } from './native-ui.mjs';

const PORT = 4180;
const out = resolve('artifacts/native');
mkdirSync(out, { recursive: true });
// A stand-in for the Telegram bot: the test plays the person pressing its buttons.
const telegram = {
  provider: 'telegram', title: 'Telegram', botName: 'detailflow_test_bot', sent: [], handler: null, lastStart: null,
  deepLink(payload) { this.lastStart = payload; return `https://bots.example/detailflow_test_bot?start=${payload}`; },
  async start(handler) { this.handler = handler; },
  stop() {},
  async sendMessage(userId, text, buttons) { this.sent.push({ userId, text, buttons }); },
  async answerCallback() {}
};
const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist'), messengers: [telegram] });
// The app reaches the server through a proxy on PORT; switching the proxy off is the phone losing the network.
const SERVER_PORT = PORT + 1;
await new Promise((done) => server.listen(SERVER_PORT, '127.0.0.1', done));
const sockets = new Set();
const proxy = net.createServer((client) => {
  const upstream = net.connect(SERVER_PORT, '127.0.0.1');
  const drop = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
  for (const socket of [client, upstream]) { sockets.add(socket); socket.on('error', drop); socket.on('close', drop); }
  client.pipe(upstream).pipe(client);
});
const network = {
  up: () => new Promise((done) => proxy.listen(PORT, '0.0.0.0', done)),
  down: () => new Promise((done) => { for (const socket of sockets) socket.destroy(); proxy.close(() => done()); })
};
await network.up();
const api = (path, init = {}) => fetch(`http://127.0.0.1:${SERVER_PORT}${path}`, { ...init, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...init.headers } });
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

  step('first launch opens sign-in on the public server; the test points it at its own');
  await launch('ru.detailflow.app', { clear: true });
  const title = await waitFor('Вход в DetailFlow', { timeout: 45_000 });
  assert.ok(!find('Адрес сервера').length && !find(/Сменить/).length, 'no server choice for people');
  screenshot(resolve(out, '01-first-launch.png'));
  // The hidden way to another server: a long press on the title.
  adb('shell', 'input', 'swipe', String(title.x), String(title.y), String(title.x), String(title.y), '2000');
  await tap(/detailflow\.ru$/);
  adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END', ...Array(30).fill('KEYCODE_DEL'));
  await type(`10.0.2.2:${PORT}`);
  screenshot(resolve(out, '01-server.png'));
  await tap('Подключиться');

  step('sign-in offers the messenger, an access code and the demo');
  // Just after a cold boot the emulator's network may not be up yet: try again, as a person would.
  // The demo button is only on the test server: it shows that the app now talks to it.
  for (let attempt = 0; ; attempt += 1) {
    const node = await waitFor(/^Демо-режим$|^По этому адресу сервер DetailFlow не отвечает/, { timeout: 30_000 });
    if (node.text === 'Демо-режим' || attempt === 2) break;
    await sleep(3000);
    if (find('Подключиться').length) await tap('Подключиться');
  }
  await waitFor('Демо-режим');
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
  // A full number with nobody behind it puts the cursor in the name: typing goes straight there.
  await sleep(800);
  await type('Ivan Petrov');
  await waitFor('Ivan Petrov');
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

  step('stage 5: estimate, approval, the signed intake act, handover and the handover act');
  const order5 = intakeOrder.id;
  await tap('Заказы');
  await tapNode(await scrollTo(/А123АА 55, Смета$/));
  await tapNode(await scrollTo('Составить смету'));
  await waitFor('Бережная мойка', { timeout: 20_000 });
  await tapNode(await scrollTo('Например, удаление битума'));
  await type('Bitum removal');
  back();
  await tapNode(await scrollTo(/^0$/));
  await type('500');
  back();
  await tapNode(await scrollTo('Добавить'));
  await waitFor('добавлено вручную');
  screenshot(resolve(out, '21-estimate.png'));
  await tapNode(await scrollTo('Выпустить смету'));
  await tapNode(await scrollTo('Клиент согласовал', { swipes: 10 }));
  await waitFor(/^Согласовано лично/, { timeout: 20_000 });
  let state5 = await (await api(`/api/orders/${order5}`)).json();
  assert.equal(state5.status, 'APPROVED');
  assert.equal(state5.estimateVersions[0].totalAmountMinor, 190000, 'wash 1 400 ₽ + own line 500 ₽');

  await tapNode(await scrollTo('Оформить и подписать', { swipes: 12 }));
  await waitFor('Акт приёмки автомобиля', { timeout: 20_000 });
  const pad = await scrollTo('Поле для подписи клиента пальцем', { swipes: 12 });
  const { x1, x2, y1, y2 } = pad.bounds;
  adb('shell', 'input', 'swipe', String(x1 + 60), String(y2 - 50), String(x2 - 60), String(y1 + 50), '600');
  await scrollTo('Подпись поставлена');
  screenshot(resolve(out, '22-signature.png'));
  await tapNode(await scrollTo('Подписать и сохранить'));
  await waitFor(/^Акт приёмки № /, { timeout: 20_000 }); // the issued act, with its number
  await scrollTo('Сотрудник центра');
  screenshot(resolve(out, '23-intake-act.png')); // the signature on the act
  state5 = await (await api(`/api/orders/${order5}`)).json();
  const act = state5.documents.find((document) => document.type === 'intake_act');
  assert.ok(act?.signed, 'the intake act is signed');
  const full = await (await api(`/api/orders/${order5}/documents/${act.id}`)).json();
  assert.ok(full.signatureDataUrl.startsWith('data:image/png;base64,iVBORw0KGgo'), 'the signature is a PNG');
  await tapNode(await scrollTo('PDF — отправить или распечатать'));
  // The PDF is made on the phone and handed to the system share sheet.
  const sheet = await waitFor(/.pdf$/, { timeout: 30_000 }).catch(() => null); // the share sheet names the file
  screenshot(resolve(out, '24-pdf-share.png'));
  assert.ok(sheet, `the share sheet opens with the PDF; on screen: ${find(/./).map((node) => node.text || node.desc).filter(Boolean).slice(0, 12).join(' | ')}`);
  console.log('  share sheet:', sheet.text);
  back(); // close the share sheet
  await sleep(1200);
  await tapNode(await scrollTo('Готово'));

  // The master's part was checked in stage 2; here it is done through the API.
  const [master] = (await (await api('/api/tenants/current/masters')).json()).items;
  const change5 = (path, method, body) => api(`/api/orders/${order5}${path}`, { method, body: JSON.stringify(body), headers: { 'idempotency-key': `s5-${path}-${Date.now()}` } });
  await change5('/assignment', 'PUT', { memberId: master.id });
  await change5('/work/start', 'POST', {});
  for (const operation of (await (await api(`/api/orders/${order5}`)).json()).work.operations) await change5(`/work/operations/${operation.id}`, 'PATCH', { status: 'DONE', note: '' });
  await change5('/work/complete', 'POST', {});
  assert.equal((await (await api(`/api/orders/${order5}`)).json()).status, 'READY');

  back(); // to the list and into the order again: it is ready now
  await tapNode(await scrollTo(/А123АА 55, Готов к выдаче$/));
  await tapNode(await scrollTo('Выдать автомобиль', { swipes: 12 }));
  await tap('Снять результат', { timeout: 20_000 });
  await shoot();
  await waitFor('Фото после работ', { timeout: 30_000 });
  await tap('Клиент осмотрел результат работ');
  await tap('Комплектность автомобиля проверена');
  screenshot(resolve(out, '25-handover.png'));
  await tapNode(await scrollTo('Выдать автомобиль и закрыть заказ'));
  const shareButton = await scrollTo('Поделиться заказ-нарядом', { swipes: 14 }); // shown once the order is closed
  assert.equal((await (await api(`/api/orders/${order5}`)).json()).status, 'CLOSED');
  screenshot(resolve(out, '27-closed.png'));
  await tapNode(shareButton);
  await sleep(3000);
  screenshot(resolve(out, '26-share.png'));
  back();
  await sleep(800);
  back();
  await waitFor(/^Все$/);

  step('stage 6: statistics, a new service, the schedule, a new member and a new role');
  await tap('Статистика');
  await waitFor('Согласовано по сметам', { timeout: 20_000 });
  await tap('7 дней');
  await waitFor('Активность по дням', { timeout: 20_000 });
  screenshot(resolve(out, '28-analytics.png'));

  await tap('Профиль');
  await tap('Каталог услуг', { timeout: 20_000 });
  await waitFor('Бережная мойка', { timeout: 20_000 });
  screenshot(resolve(out, '29-catalog.png'));
  await tap('＋ Услуга');
  await tap('Например, озонирование салона', { timeout: 20_000 });
  await type('Ozon');
  back();
  await tap(/^0$/);
  await type('1500');
  back();
  const form6 = find(/./).map((node) => node.text || node.desc).filter(Boolean).join(' | ');
  await tapNode(await scrollTo('Добавить услугу'));
  await sleep(2500);
  if (!(await (await api('/api/tenants/current/catalog')).json()).items.some((item) => item.name === 'Ozon')) {
    console.log('  form was:', form6);
    console.log('  now:', find(/./).map((node) => node.text || node.desc).filter(Boolean).join(' | '));
  }
  for (let swipe = 0; swipe < 4; swipe += 1) adb('shell', 'input', 'swipe', '540', '700', '540', '1900', '300'); // back to the top of the catalog
  await scrollTo('Ozon', { swipes: 14 });
  await sleep(1500); // the list reloads on return
  await tap('Ozon');
  await waitFor('Цена, ₽', { timeout: 20_000 }); // the edit form of the new service
  await scrollTo('Доступно для записи');
  await scrollTo('Сохранить услугу');
  const catalog6 = await (await api('/api/tenants/current/catalog')).json();
  const ozon = catalog6.items.find((item) => item.name === 'Ozon');
  assert.equal(ozon?.basePrice?.amountMinor, 150000, 'the new service is in the catalog at 1 500 ₽');
  back();
  back();

  await tap('График центра', { timeout: 20_000 });
  await tap('Вс', { timeout: 20_000 });
  await tapNode(await scrollTo('Сохранить график'));
  await waitFor(/^График сохранён/, { timeout: 20_000 });
  screenshot(resolve(out, '30-schedule.png'));
  assert.ok(!(await (await api('/api/tenants/current/settings')).json()).workingDays.includes(0), 'Sunday is off');
  back();

  await tap('Команда и роли', { timeout: 20_000 });
  await tap('＋ Сотрудник', { timeout: 20_000 });
  await tap('Например, Мария Орлова', { timeout: 20_000 });
  await type('Petr Ivanov');
  back();
  await tapNode(await scrollTo('Добавить сотрудника'));
  await waitFor('Поделиться кодом', { timeout: 20_000 });
  screenshot(resolve(out, '31-member-code.png'));
  await tap('Готово');
  await waitFor('Petr Ivanov', { timeout: 20_000 });
  assert.ok((await (await api('/api/tenants/current/team')).json()).items.some((member) => member.displayName === 'Petr Ivanov'));
  const permission6 = (await (await api('/api/tenants/current/roles')).json()).permissions[0];
  await tap('Роли и права');
  await tap('＋ Роль', { timeout: 20_000 });
  await tap('Например, Старший мастер', { timeout: 20_000 });
  await type('Senior');
  back();
  await tap(permission6.title);
  await tapNode(await scrollTo('Создать роль'));
  await waitFor('Senior', { timeout: 20_000 });
  screenshot(resolve(out, '32-roles.png'));
  const senior = (await (await api('/api/tenants/current/roles')).json()).items.find((role) => role.name === 'Senior');
  assert.deepEqual(senior?.permissions, [permission6.key]);
  back();
  await waitFor('Управление центром', { timeout: 20_000 });

  step('stage 7: without the server — work on an order and a new booking, then sync');
  const offlineOrder = await approvedOrder();
  const [master7] = (await (await api('/api/tenants/current/masters')).json()).items;
  await api(`/api/orders/${offlineOrder}/assignment`, { method: 'PUT', body: JSON.stringify({ memberId: master7.id }), headers: { 'idempotency-key': `s7-${Date.now()}` } });
  await tap('Заказы');
  await sleep(4000); // the list loads and keeps unfinished orders, masters and the booking pack on the phone
  await tapNode(await scrollTo(/В476РЕ 155, Согласован$/));
  await scrollTo('Начать работу');
  await sleep(1500);
  await network.down();
  await tapNode(await scrollTo('Начать работу'));
  await waitFor('Нет связи с сервером', { timeout: 30_000 });
  await tapNode(await scrollTo('Бережная мойка'));
  await waitFor(/^1\/2$/, { timeout: 20_000 });
  screenshot(resolve(out, '33-offline-work.png'));
  back();
  await tap('Новая');
  await tap('+7 999 000-00-00', { timeout: 20_000 });
  await type('79131234567');
  await waitFor('Алексей Морозов', { timeout: 30_000 });
  back();
  await tap(/^В476РЕ 155,/);
  await waitFor('Комплексы', { timeout: 20_000 }); // services and prices from the copy on the phone
  await scrollTo('Бережная мойка'); // below the service added in stage 6
  adb('shell', 'input', 'swipe', '540', '1500', '540', '900', '400'); // above the price dock
  await sleep(600);
  await tap('Бережная мойка');
  await waitFor(/^[\d ]+ ₽ · /, { timeout: 20_000 });
  await tap('Выбрать время');
  await tapNode(await scrollTo('19:00'));
  await tapNode(await scrollTo('Записать на 19:00'));
  await waitFor('Запись сохранена на телефоне', { timeout: 20_000 });
  screenshot(resolve(out, '34-offline-booking.png'));
  assert.equal(await fetch(`http://127.0.0.1:${PORT}/api/ready`).then(() => 'reachable', () => 'unreachable'), 'unreachable', 'the phone is really offline');

  await network.up();
  const synced = async () => {
    const order = await (await api(`/api/orders/${offlineOrder}`)).json();
    const bookings = (await (await api('/api/bookings?view=upcoming&limit=50')).json()).items;
    return order.status === 'IN_PROGRESS' && order.work.operations.some((operation) => operation.status === 'DONE')
      && bookings.some((booking) => booking.customer.id === 'cust_alexey' && booking.startAt.endsWith('T19:00:00+03:00'));
  };
  const started7 = Date.now();
  while (!(await synced())) {
    assert.ok(Date.now() - started7 < 60_000, 'the queue reaches the server within a minute');
    await sleep(2000);
  }
  await tap('Новая запись');
  await tap('Профиль');

  step('profile: demo sign-out returns to sign-in');
  await tap('Профиль');
  await waitFor('Управление центром');
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
  const after = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/session`, { headers: { authorization: `Bearer ${created.accessToken}` } });
  assert.equal(after.status, 401, 'the access code no longer works');
  screenshot(resolve(out, '07-after-delete.png'));

  step('a new owner creates a center from the sign-in screen through Telegram');
  await tap('Создать свой центр');
  await waitFor('Новый центр');
  await tap('Продолжить через Telegram');
  await sleep(2500);
  // The bot link opens a browser (no Telegram on the emulator): come back to the app.
  for (let attempt = 0; attempt < 3 && !find(/^Отмена$/).length; attempt += 1) { back(); await sleep(1500); }
  assert.ok(telegram.lastStart, 'the app asked for a bot link');
  // The person starts the bot and confirms; the app is polling meanwhile.
  await telegram.handler({ provider: 'telegram', kind: 'start', userId: '880001', displayName: 'Nikita', payload: telegram.lastStart });
  const prompt = telegram.sent.at(-1);
  assert.match(prompt.text, /Создание центра/);
  await telegram.handler({ provider: 'telegram', kind: 'callback', userId: '880001', payload: prompt.buttons[0][0].payload, callbackId: 'signup' });
  await tapNode(await scrollTo('Например, Детейлинг Север'));
  await type('Detailing Test');
  back();
  await tapNode(await scrollTo('Имя Фамилия'));
  await type('Nikita Owner');
  back();
  await tapNode(await scrollTo('Создать центр'));
  await waitFor(/^Все$/, { timeout: 20_000 });
  // The new center is empty: the owner is told what to do first, and a booking without services says where they go.
  await waitFor('Первые шаги', { timeout: 20_000 });
  screenshot(resolve(out, '35-first-steps.png'));
  await tap('Добавьте услуги');
  await waitFor('＋ Услуга', { timeout: 20_000 });
  back();
  await tap('Профиль');
  await waitFor('Detailing Test', { timeout: 20_000 });
  await waitFor('Управление центром');
  screenshot(resolve(out, '36-new-center-owner.png'));
  console.log('native smoke: ok');
} finally {
  await network.down().catch(() => {});
  await new Promise((done) => server.close(done));
}
