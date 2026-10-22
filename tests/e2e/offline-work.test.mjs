import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';
import { waitForOfflineCopy, acceptLegal } from './offline-helpers.mjs';

async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
}

test('mobile offline: a master works on an order without the server and the changes arrive once it is back', async () => {
  const server = createDetailFlowServer({
    databasePath: ':memory:', seed: true, staticDir: resolve('dist'),
    authTokens: new Map([
      ['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin', 'intake', 'master'] }],
      ['e2e-master-token', { tenantId: 'tenant_demo', displayName: 'Дмитрий Соколов', roles: ['master'], memberId: 'member_demo_master' }]
    ])
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.ok(response.ok, `${method} ${path} → ${response.status}`);
    return response.json();
  };
  const booking = await call('/api/bookings', 'POST', {
    customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt: '2026-12-28T10:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
  }, { 'idempotency-key': 'e2e-offline-booking' });
  const order = await call('/api/orders', 'POST', { bookingId: booking.id });
  await call(`/api/orders/${order.id}/intake`, 'PUT', { conditionSummary: 'Принят', findings: [], recommendations: [] });
  const estimate = await call(`/api/orders/${order.id}/estimates`, 'POST', { lines: [
    { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 },
    { sourceType: 'custom', name: 'Чернение шин', amountMinor: 30000, durationMinutes: 10 }
  ] });
  await call(`/api/orders/${order.id}/estimate-approvals`, 'POST', { estimateVersionId: estimate.id, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна' });
  await call(`/api/orders/${order.id}/assignment`, 'PUT', { memberId: 'member_demo_master' });

  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await acceptLegal(baseUrl, 'e2e-master-token');
  await context.addInitScript(() => localStorage.setItem('detailflow.session', 'e2e-master-token'));
  const page = await context.newPage();

  try {
    // Online: the master's queue loads and unfinished orders are kept on the phone in the background.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId(`order-card-${order.id}`).waitFor();
    await waitForOfflineCopy(page, [`/api/orders/${order.id}`, `/api/bookings/${booking.id}`]);

    // The server is gone: the order still opens from the phone's copy.
    await context.setOffline(true);
    await page.getByTestId(`order-card-${order.id}`).click();
    await page.getByTestId('open-order-workspace').click();
    await page.getByTestId('start-work').click();
    await page.getByTestId('offline-banner').waitFor();
    await page.getByTestId('work-operation-0').click();
    await page.getByTestId('work-operation-1').click();
    await page.getByTestId('work-operation-1').locator('em', { hasText: 'Готово' }).waitFor();
    assert.match(await page.getByTestId('offline-banner').innerText(), /Нет подключения[\s\S]*3 изменения сохранены на телефоне и отправятся сами/i);
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '106-offline-work.png') });

    // Rules still apply offline: pausing needs a reason.
    await page.getByLabel('Причина паузы').fill('');
    await page.getByTestId('toggle-work-pause').click();
    assert.match(await page.locator('.inline-error').innerText(), /причину паузы/i);
    await page.getByLabel('Причина паузы').fill('Ждём химию');
    await page.getByTestId('toggle-work-pause').click();
    await page.getByTestId('toggle-work-pause').getByText('Продолжить').waitFor();
    await page.getByTestId('toggle-work-pause').click();
    await page.getByTestId('toggle-work-pause').getByText('Пауза').waitFor();
    assert.equal((await call(`/api/orders/${order.id}`)).status, 'APPROVED', 'nothing reached the server yet');

    await page.getByTestId('complete-work').click();
    await page.getByTestId('order-ready').waitFor();
    assert.match(await page.getByTestId('offline-banner').innerText(), /6 изменений/);

    // Back online: the queue is sent in order and the server ends up in the same state.
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByTestId('offline-banner').waitFor({ state: 'detached' });
    await page.getByTestId('sync-pending').waitFor({ state: 'detached', timeout: 15_000 });
    const synced = await call(`/api/orders/${order.id}`);
    assert.equal(synced.status, 'READY');
    assert.deepEqual(synced.work.operations.map((operation) => operation.status), ['DONE', 'DONE']);
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '107-offline-synced.png') });
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
