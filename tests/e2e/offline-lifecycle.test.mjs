import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';
import { waitForOfflineCopy } from './offline-helpers.mjs';

async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
}

function todayInMoscowAt(time) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
  return `${today}T${time}:00+03:00`;
}

test('mobile offline: from "client arrived" to handover without the server, then everything reaches it', async () => {
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
  // A booking for tomorrow: it is kept whole on the phone when the list loads.
  const booking = (await call('/api/bookings', 'POST', {
    customerId: 'cust_alexey', vehicleId: 'veh_camry', channel: 'call', startAt: todayInMoscowAt('11:00'), selections: [{ type: 'service', id: 'service_wash' }]
  }, { 'idempotency-key': 'e2e-offline-lifecycle' })).body;

  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const photo = resolve(artifacts, 'offline-photo.png');
  await writeFile(photo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('bookings-nav').click();
    await page.getByTestId(`booking-card-${booking.id}`).waitFor();
    await waitForOfflineCopy(page, [`/api/bookings/${booking.id}`, '/api/tenants/current/masters', '/api/offline/booking-pack']);

    await context.setOffline(true);
    await page.getByTestId(`booking-card-${booking.id}`).click();
    await page.getByTestId('start-booking-intake').click();
    await page.getByTestId('order-intake').waitFor();

    await page.getByRole('button', { name: /^Фото/ }).click();
    await page.getByTestId('intake-photo-input').setInputFiles(photo);
    await page.locator('.photo-tab-panel img').first().waitFor();
    await page.getByRole('button', { name: 'Осмотр' }).click();
    await page.getByTestId('save-intake').click();
    await page.getByTestId('order-estimate').waitFor();
    await page.getByTestId('create-estimate').click();
    await page.getByTestId('order-approval').waitFor();
    await page.getByTestId('approve-estimate').click();
    await page.getByTestId('order-approved').waitFor();
    await page.getByTestId('master-option-member_demo_master').click();
    await page.getByTestId('assign-master').click();
    await page.getByTestId('start-work').click();
    await page.getByTestId('master-work').waitFor();
    const operations = await page.locator('[data-testid^="work-operation-"]').count();
    for (let index = 0; index < operations; index += 1) await page.getByTestId(`work-operation-${index}`).click();
    await page.getByTestId('complete-work').click();
    await page.getByTestId('order-ready').waitFor();
    await page.getByTestId('open-delivery').click();
    await page.getByTestId('result-photo-input').setInputFiles(photo);
    await page.getByRole('button', { name: 'Клиент осмотрел результат работ' }).click();
    await page.getByRole('button', { name: 'Комплектность автомобиля проверена' }).click();
    await page.getByTestId('close-order').click();
    await page.getByTestId('order-closed').waitFor();
    const banner = await page.getByTestId('offline-banner').innerText();
    const pending = Number(/(\d+) изменени/.exec(banner)?.[1]);
    assert.ok(pending >= 10, `the whole visit is queued on the phone: ${banner}`);
    assert.equal((await call(`/api/bookings/${booking.id}`)).body.status, 'CONFIRMED');
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '111-offline-order-closed.png') });

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByTestId('offline-banner').waitFor({ state: 'detached' });
    await page.getByTestId('sync-pending').waitFor({ state: 'detached', timeout: 30_000 });
    assert.equal(await page.getByTestId('sync-failed').count(), 0, 'nothing was refused');

    const orders = (await call('/api/orders?limit=20')).body.items.filter((item) => item.customer.id === 'cust_alexey' && item.vehicle.id === 'veh_camry');
    assert.equal(orders.length, 1, 'one order, no duplicates');
    const order = (await call(`/api/orders/${orders[0].id}`)).body;
    assert.equal(order.status, 'CLOSED');
    assert.equal(order.bookingId, booking.id);
    assert.equal(order.approval.decision, 'APPROVED');
    assert.equal(order.assignment.memberId, 'member_demo_master');
    assert.ok(order.work.operations.every((operation) => operation.status === 'DONE'));
    assert.deepEqual(order.photos.map((item) => item.phase).sort(), ['intake', 'result']);
    assert.equal(order.handover.responsible.length > 1, true);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
