import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

test('mobile vehicle history and explicit owner transfer work end to end', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });

  try {
    const customerResponse = await fetch(`http://127.0.0.1:${port}/api/customers`, {
      method: 'POST',
      headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Мария Соколова', phone: '+7 999 111-22-33' })
    });
    assert.equal(customerResponse.status, 201);
    const customer = await customerResponse.json();

    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /По госномеру/ }).click();
    await page.getByTestId('main-search').fill('А123АА 55');
    await page.getByTestId('open-vehicle-profile-veh_mazda').waitFor();
    await page.getByTestId('open-vehicle-profile-veh_mazda').click();
    await page.getByTestId('vehicle-profile').waitFor();
    await page.waitForTimeout(400);
    assert.match(await page.getByTestId('vehicle-profile').innerText(), /Алексей Морозов/);
    assert.match(await page.getByTestId('vehicle-profile').innerText(), /#history_1/i);
    const nav = await page.locator('.bottom-nav').boundingBox();
    assert.ok(nav && Math.abs(nav.y + nav.height - 844) < 1, 'bottom navigation stays pinned on vehicle history');
    await page.screenshot({ path: resolve(artifacts, '45-vehicle-profile.png') });

    await page.getByTestId('open-transfer').click();
    await page.getByTestId('transfer-phone').fill('+7 999 111-22-33');
    await page.getByTestId(`transfer-customer-${customer.id}`).waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(200);
    await page.getByTestId('vehicle-transfer').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '46-vehicle-owner-search.png') });
    await page.getByTestId(`transfer-customer-${customer.id}`).click();
    await page.getByTestId('confirm-transfer').waitFor();
    await page.getByTestId('confirm-transfer').click();
    await page.getByText(/Владелец изменён: Мария Соколова/).waitFor();
    assert.match(await page.getByTestId('vehicle-profile').innerText(), /2\s+владельцев/);
    assert.match(await page.getByTestId('vehicle-profile').innerText(), /Алексей Морозов/);
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(200);
    await page.locator('.vehicle-owner-card').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '47-vehicle-owner-transferred.png') });

    await page.getByRole('button', { name: 'Отметить проданным' }).click();
    await page.getByText('Продан', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Вернуть в работу' }).click();
    await page.getByText(/Автомобиль возвращён в работу/).waitFor();
    assert.match(await page.getByTestId('vehicle-profile').innerText(), /3\s+изменений/);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
