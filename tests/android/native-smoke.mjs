// Native app smoke run on an emulator (or a phone over USB) against a throwaway server with demo data.
// Prerequisites: the release APK of mobile/ is installed (adb install -r ...), an emulator is running.
// Run from the repository root: node tests/android/native-smoke.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDetailFlowServer } from '../../server/app.mjs';
import { back, find, launch, screenshot, sleep, tap, type, waitFor } from './native-ui.mjs';

const PORT = 4180;
const out = resolve('artifacts/native');
mkdirSync(out, { recursive: true });
const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
await new Promise((done) => server.listen(PORT, '0.0.0.0', done));
const api = (path, init = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...init.headers } });
const step = (name) => console.log(`· ${name}`);

try {
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
