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

test('mobile workspaces follow the employee role: admin assigns a real master, master and intake see their own queues', async () => {
  const server = createDetailFlowServer({
    databasePath: ':memory:', seed: true, staticDir: resolve('dist'),
    authTokens: new Map([
      ['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin', 'intake', 'master'] }],
      ['e2e-master-token', { tenantId: 'tenant_demo', displayName: 'Дмитрий Соколов', roles: ['master'], memberId: 'member_demo_master' }],
      ['e2e-intake-token', { tenantId: 'tenant_demo', displayName: 'Ирина Лебедева', roles: ['intake'], memberId: 'member_demo_intake' }]
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
  }, { 'idempotency-key': 'e2e-roles-booking' });
  const order = await call('/api/orders', 'POST', { bookingId: booking.id });
  await call(`/api/orders/${order.id}/intake`, 'PUT', { conditionSummary: 'Принят', findings: [], recommendations: [] });
  const estimate = await call(`/api/orders/${order.id}/estimates`, 'POST', { lines: [
    { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 }
  ] });
  await call(`/api/orders/${order.id}/estimate-approvals`, 'POST', {
    estimateVersionId: estimate.id, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна'
  });
  const waiting = await call('/api/bookings', 'POST', {
    customerId: 'cust_alexey', vehicleId: 'veh_camry', channel: 'call', startAt: '2026-12-29T10:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
  }, { 'idempotency-key': 'e2e-roles-second' });

  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const openAs = async (token) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    if (token) await context.addInitScript((value) => localStorage.setItem('detailflow.session', value), token);
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    return page;
  };

  try {
    // Admin assigns a master picked from the real team.
    const admin = await openAs(null);
    await admin.getByTestId('orders-nav').click();
    await admin.getByTestId(`order-card-${order.id}`).click();
    await admin.getByTestId('open-order-workspace').click();
    await admin.getByTestId('master-option-member_demo_master').waitFor();
    assert.match(await admin.getByTestId('master-option-member_demo_master').innerText(), /Дмитрий Соколов\s*Свободен/);
    assert.equal(await admin.getByText('Алексей Волков').count(), 0, 'no made-up masters');
    await settle(admin);
    await admin.getByTestId('master-option-member_demo_master').scrollIntoViewIfNeeded();
    await admin.screenshot({ path: resolve(artifacts, '89-assign-real-master.png') });
    await admin.getByTestId('assign-master').click();
    await admin.getByText('Назначен', { exact: true }).waitFor();
    assert.equal((await call(`/api/orders/${order.id}`)).assignment.memberId, 'member_demo_master');
    await admin.context().close();

    // The master opens the app on their own queue.
    const master = await openAs('e2e-master-token');
    await master.getByTestId('orders-workspace').waitFor();
    const mine = master.locator('.workspace-filters button.selected');
    assert.match(await mine.innerText(), /^Мои 1$/);
    assert.equal(await master.locator('[data-testid^="order-card-"]').count(), 1);
    await settle(master);
    await master.screenshot({ path: resolve(artifacts, '90-master-my-orders.png') });
    for (const [nav, section] of [['bookings-nav', 'Записи'], ['analytics-nav', 'Статистика'], ['new-booking-nav', 'Новая запись']]) {
      await master.getByTestId(nav).click();
      await master.getByTestId('no-access').waitFor();
      assert.match(await master.getByTestId('no-access').innerText(), new RegExp(`«${section}» недоступен`));
    }
    await settle(master);
    await master.screenshot({ path: resolve(artifacts, '91-master-no-access.png') });
    await master.context().close();

    // Intake staff start on the schedule without leads or booking changes.
    const intake = await openAs('e2e-intake-token');
    await intake.getByTestId('bookings-workspace').waitFor();
    assert.equal(await intake.getByRole('tab', { name: /Обращения/ }).count(), 0);
    await intake.getByTestId(`booking-card-${waiting.id}`).click();
    await intake.getByTestId('start-booking-intake').waitFor();
    assert.equal(await intake.getByRole('button', { name: 'Перенести запись' }).count(), 0);
    assert.equal(await intake.getByTestId('edit-composition').count(), 0);
    assert.equal(await intake.getByTestId('booking-open-customer').count(), 0, 'the customer card needs customer rights');
    await settle(intake);
    await intake.screenshot({ path: resolve(artifacts, '92-intake-booking.png') });
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
