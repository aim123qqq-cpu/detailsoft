// Smoke test of the debug APK on an emulator or USB device (not part of `pnpm test`).
// Prerequisites: the adb server is running, the app is open and connected to the server; then
//   node tests/android/smoke.mjs
// It creates one real booking in the demo center of the connected server.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { _android as android } from 'playwright-core';

const adb = process.env.ADB ?? resolve(process.env.LOCALAPPDATA ?? '', 'Android/Sdk/platform-tools/adb.exe');
const screenshot = (name) => {
  execFileSync(adb, ['shell', 'screencap', '-p', '/sdcard/detailflow-smoke.png']);
  execFileSync(adb, ['pull', '/sdcard/detailflow-smoke.png', resolve('artifacts', name)]);
};

const [device] = await android.devices();
assert.ok(device, 'no device: start the emulator or connect a phone with USB debugging');
const page = await (await device.webView({ pkg: 'ru.detailflow.app' })).page();
try {
  assert.equal(await page.evaluate(() => typeof window.DetailFlowAndroid?.share), 'function', 'native bridge is present');
  assert.equal(await page.evaluate(() => typeof navigator.share), 'function', 'share goes to Android');
  assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined', 'plain http: no randomUUID, the fallback is used');

  if (await page.getByTestId('login-cancel').count()) await page.getByTestId('login-cancel').click();
  await page.getByTestId('main-search').fill('+7 913 123-45-67');
  await page.locator('[data-testid^="vehicle-"]').first().click();
  await page.getByTestId('services-screen').waitFor();
  await page.getByTestId('offering-service_wash').locator('.offering-main').click();
  await page.getByTestId('choose-time').click();
  await page.getByTestId('schedule-screen').waitFor();
  await page.locator('[data-testid^="slot-"]:not([disabled])').first().click();
  await page.getByTestId('confirm-booking').click();
  await page.getByTestId('booking-confirmed').waitFor();
  assert.match(await page.getByTestId('booking-confirmed').innerText(), /запись подтверждена/i);
  await page.waitForTimeout(500);
  screenshot('97-android-booking-confirmed.png');

  await page.getByTestId('profile-nav').click();
  await page.getByTestId('profile-server').waitFor();
  assert.match(await page.getByTestId('profile-server').innerText(), /http:\/\/[\d.]+:\d+/);
  await page.getByTestId('profile-server').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  screenshot('98-android-profile-server.png');

  await page.evaluate(() => navigator.share({ title: 'DetailFlow', text: 'Проверка «Поделиться» из APK' }));
  await new Promise((done) => setTimeout(done, 1500));
  screenshot('99-android-share-sheet.png');
  execFileSync(adb, ['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
  console.log('Android smoke passed');
} finally {
  await device.close();
}
