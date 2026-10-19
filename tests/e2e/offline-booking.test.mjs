import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';

async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
}

/** Tomorrow in the center's time zone: the first day the booking screen offers. */
function tomorrowInMoscow() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

test('mobile offline: a booking made without the server is sent later and kept with a conflict mark when its time was taken', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  const day = tomorrowInMoscow();
  const startAt = `${day}T10:00:00+03:00`;

  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  try {
    // Online: the booking pack and the bookings list are kept on the phone.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(async () => {
      const request = indexedDB.open('detailflow-offline');
      const db = await new Promise((done) => { request.onsuccess = () => done(request.result); });
      const keys = await new Promise((done) => { const all = db.transaction('cache').objectStore('cache').getAllKeys(); all.onsuccess = () => done(all.result); });
      return keys.some((key) => String(key).endsWith('/api/offline/booking-pack'));
    }, null, { timeout: 10_000 });
    await page.getByTestId('bookings-nav').click();
    await page.getByTestId('bookings-workspace').waitFor();

    // No server: find the customer, pick a service and a time, confirm.
    await context.setOffline(true);
    await page.getByTestId('new-booking-nav').click();
    await page.getByTestId('main-search').fill('+7 913 123-45-67');
    await page.getByTestId('vehicle-veh_camry').click();
    await page.getByTestId('services-screen').getByText('Бережная мойка').first().waitFor();
    await page.getByTestId('offering-service_wash').locator('.offering-main').click();
    await page.getByTestId('choose-time').click();
    await page.getByTestId('schedule-screen').waitFor();
    await page.getByTestId('slot-10:00').click();
    await page.getByTestId('confirm-booking').click();
    await page.getByTestId('booking-pending-sync').waitFor();
    assert.match(await page.getByTestId('booking-confirmed').innerText(), /сохранена на телефоне/i);
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '109-offline-booking-saved.png') });

    await page.getByTestId('bookings-nav').click();
    const pendingCard = page.locator('[data-testid^="booking-card-"]', { hasText: 'Не отправлено' });
    await pendingCard.waitFor();
    assert.match(await pendingCard.innerText(), /10:00[\s\S]*Алексей Морозов/);

    // Meanwhile another phone fills 10:00 (two cars at once in the demo center).
    for (const key of ['other-1', 'other-2']) {
      assert.equal((await call('/api/bookings', 'POST', { customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt, selections: [{ type: 'service', id: 'service_wash' }] }, { 'idempotency-key': key })).status, 201);
    }

    // Back online: the booking is kept, marked as a conflict that has to be moved.
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const conflictCard = page.locator('[data-testid^="booking-card-"]', { hasText: 'Конфликт времени' });
    await conflictCard.waitFor({ timeout: 20_000 });
    const sent = (await call('/api/bookings?view=upcoming&limit=50')).body.items.filter((item) => item.startAt === startAt);
    assert.equal(sent.length, 3, 'nothing was lost and nothing doubled');
    const offlineBooking = sent.find((item) => item.vehicle.id === 'veh_camry');
    assert.equal(offlineBooking.slotConflict, true);

    await conflictCard.click();
    await page.getByTestId('booking-slot-conflict').waitFor();
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '110-booking-slot-conflict.png') });

    // Moving it to a free time clears the conflict.
    await page.getByRole('button', { name: 'Перенести запись', exact: true }).click();
    await page.locator('#reschedule-date').fill(day);
    await page.locator('.reschedule-slots button', { hasText: '12:00' }).click();
    await page.locator('.reschedule-submit').click();
    await page.getByTestId('booking-slot-conflict').waitFor({ state: 'detached' });
    const moved = (await call(`/api/bookings/${offlineBooking.id}`)).body;
    assert.equal(moved.startAt, `${day}T12:00:00+03:00`);
    assert.equal(moved.slotConflict, false);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
