import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
}

test('mobile scheduled visit: arrival starts intake, orders resume from lists, no-show frees the slot', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let keyCounter = 0;
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.ok(response.ok, `${method} ${path} → ${response.status}`);
    return response.json();
  };
  const book = (startAt, vehicleId = 'veh_mazda') => call('/api/bookings', 'POST', {
    customerId: 'cust_alexey', vehicleId, channel: 'call', startAt, selections: [{ type: 'service', id: 'service_wash' }]
  }, { 'idempotency-key': `e2e-resume-${keyCounter += 1}` });

  const scheduled = await book('2026-12-29T10:00:00+03:00');
  const missed = await book('2026-01-20T10:00:00+03:00', 'veh_camry');

  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const headerBack = page.locator('.app-header .icon-button');

  try {
    // The client arrives for a booking made earlier.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('bookings-nav').click();
    await page.getByTestId(`booking-card-${scheduled.id}`).click();
    await page.getByTestId('booking-arrival').waitFor();
    assert.equal(await page.getByTestId('mark-no-show').count(), 0, 'a future booking cannot be marked as a no-show');
    await settle(page);
    await page.getByTestId('booking-arrival').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '85-booking-arrival.png') });

    await page.getByTestId('start-booking-intake').click();
    await page.getByTestId('order-intake').waitFor();
    assert.match(await page.locator('.app-header h1').innerText(), /Приёмка автомобиля/);
    assert.equal(await page.locator('.bottom-nav').count(), 1);
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '86-intake-from-booking.png') });
    await headerBack.click();
    await page.getByTestId('open-booking-order').waitFor();
    assert.equal(await page.getByTestId('start-booking-intake').count(), 0, 'after intake started the booking offers the order instead');

    // Progress the order elsewhere (intake, estimate, approval, master) and resume it from Orders.
    const order = (await call('/api/orders?limit=20')).items.find((item) => item.vehicle.id === 'veh_mazda' && item.status === 'INTAKE');
    await call(`/api/orders/${order.id}/intake`, 'PUT', {
      conditionSummary: 'Принят при клиенте', findings: [{ zone: 'Кузов', severity: 'LOW', note: 'Мелкие царапины' }], recommendations: []
    });
    const estimate = await call(`/api/orders/${order.id}/estimates`, 'POST', { lines: [
      { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 }
    ] });
    await call(`/api/orders/${order.id}/estimate-approvals`, 'POST', {
      estimateVersionId: estimate.id, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна'
    });
    await call(`/api/orders/${order.id}/assignment`, 'PUT', { masterName: 'Дмитрий Соколов' });
    const started = await call(`/api/orders/${order.id}/work/start`, 'POST', {});

    await page.getByTestId('orders-nav').click();
    await page.getByTestId(`order-card-${order.id}`).click();
    await page.getByTestId('open-order-workspace').click();
    await page.getByTestId('master-work').waitFor();
    assert.match(await page.locator('.app-header h1').innerText(), /Работы мастера/);
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '87-resume-master-work.png') });
    await headerBack.click();
    await page.getByTestId('order-details').waitFor();

    for (const operation of started.work.operations) {
      await call(`/api/orders/${order.id}/work/operations/${operation.id}`, 'PATCH', { status: 'DONE', note: '' });
    }
    await call(`/api/orders/${order.id}/work/complete`, 'POST', {});
    await page.getByTestId('open-order-workspace').click();
    await page.getByTestId('order-ready').waitFor();
    await headerBack.click();
    await page.getByText('Готов к выдаче', { exact: false }).first().waitFor();
    assert.match(await page.getByTestId('order-details').innerText(), /Готов к выдаче/, 'order details refresh after returning');

    // A missed visit is marked as a no-show and stops occupying capacity.
    await page.getByTestId('bookings-nav').click();
    await page.getByTestId('overdue-bookings').waitFor();
    assert.equal(await page.getByTestId('overdue-bookings').getByTestId(`booking-card-${missed.id}`).count(), 1, 'the missed visit waits for a mark');
    assert.equal(await page.getByTestId('overdue-bookings').getByTestId(`booking-card-${scheduled.id}`).count(), 0);
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '93-overdue-bookings.png') });
    await page.getByTestId(`booking-card-${missed.id}`).click();
    await page.getByTestId('mark-no-show').click();
    await page.getByTestId('no-show-panel').waitFor();
    await settle(page);
    await page.getByTestId('no-show-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '88-no-show-confirm.png') });
    await page.getByTestId('confirm-no-show').click();
    await page.locator('.booking-details-hero .status-pill', { hasText: 'Не приехал' }).waitFor();
    assert.equal(await page.getByTestId('booking-arrival').count(), 0);
    assert.equal((await call(`/api/bookings/${missed.id}`)).status, 'NO_SHOW');
    await page.locator('.details-back:visible').click();
    await page.getByTestId('bookings-workspace').waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.getByTestId('overdue-bookings').count(), 0, 'nothing left to mark');
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
