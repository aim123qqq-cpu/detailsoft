import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';
import { waitForOfflineCopy } from './offline-helpers.mjs';

async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
}

test('mobile offline: a new customer with a car and a booking; the phone was registered meanwhile, so it joins the existing customer', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  const phone = '+7 900 444-33-22';

  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForOfflineCopy(page, ['/api/offline/booking-pack']);

    // No server: a customer unknown to the phone, a car typed by hand, a booking.
    await context.setOffline(true);
    await page.getByTestId('main-search').fill(phone);
    await page.getByText('Клиент не найден').waitFor();
    await page.getByLabel('Имя клиента').fill('Ольга Новикова');
    await page.getByRole('button', { name: 'Создать клиента' }).click();
    await page.getByTestId('add-vehicle-screen').waitFor();
    await page.getByRole('tab', { name: 'Ввести вручную' }).click();
    await page.getByTestId('manual-make').fill('Lada');
    await page.getByTestId('manual-model').fill('Vesta');
    await page.getByTestId('manual-class').selectOption('Средний');
    await page.getByTestId('plate-input').fill('Е002КХ 55');
    await page.getByTestId('color-input').fill('белый');
    await page.getByTestId('save-vehicle').click();
    await page.getByTestId('services-screen').getByText('Бережная мойка').first().waitFor();
    await page.getByTestId('offering-service_wash').locator('.offering-main').click();
    await page.getByTestId('choose-time').click();
    await page.getByTestId('schedule-screen').waitFor();
    await page.locator('[data-testid^="slot-"]:not([disabled])').first().click();
    await page.getByTestId('confirm-booking').click();
    await page.getByTestId('booking-pending-sync').waitFor();
    assert.match(await page.getByTestId('offline-banner').innerText(), /3 изменения/);

    // Meanwhile the same phone is registered from another device.
    const other = await call('/api/customers', 'POST', { name: 'Ольга Новикова (с ресепшена)', phone });
    assert.equal(other.status, 201);

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const question = page.getByTestId('sync-duplicate-customer');
    await question.waitFor({ timeout: 20_000 });
    assert.match(await question.innerText(), /Ольга Новикова[\s\S]*уже есть[\s\S]*с ресепшена/);
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '112-offline-duplicate-customer.png') });

    await page.getByTestId('sync-same-customer').click();
    await question.waitFor({ state: 'detached' });
    // The rest of the queue (car, booking) is sent after the answer: wait for the server to have it.
    const deadline = Date.now() + 20_000;
    while (!(await call('/api/bookings?view=upcoming&limit=50')).body.items.some((item) => item.customer.id === other.body.id)) {
      assert.ok(Date.now() < deadline, 'the booking reached the server');
      await page.waitForTimeout(200);
    }
    assert.equal(await page.getByTestId('sync-failed').count(), 0);

    const customers = (await call(`/api/customers?phone=${encodeURIComponent(phone)}`)).body.items;
    assert.equal(customers.length, 1, 'no duplicate customer');
    assert.equal(customers[0].id, other.body.id);
    assert.deepEqual(customers[0].vehicles.map((vehicle) => vehicle.plate), ['Е002КХ 55'], 'the car joined the existing customer');
    const bookings = (await call('/api/bookings?view=upcoming&limit=50')).body.items.filter((item) => item.customer.id === other.body.id);
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].vehicle.plate, 'Е002КХ 55');
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
