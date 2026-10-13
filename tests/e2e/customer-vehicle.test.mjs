import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

test('mobile customer → add vehicle → services flow works without a success screen', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });

  try {
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('main-search').fill('+7 913 123-45-67');
    await page.getByTestId('customer-result').waitFor();
    assert.equal(await page.locator('[data-testid^="vehicle-"]').count(), 2);
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(artifacts, '01-customer-vehicles.png'), fullPage: true });

    await page.getByRole('button', { name: 'Добавить автомобиль' }).click();
    await page.getByTestId('add-vehicle-screen').waitFor();
    await page.getByRole('button', { name: /хэтчбек/ }).click();
    await page.getByTestId('plate-input').fill('К777КК 55');
    await page.getByTestId('color-input').fill('графитовый');
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(artifacts, '02-add-vehicle.png'), fullPage: true });

    await page.getByTestId('save-vehicle').click();
    await page.getByTestId('services-screen').waitFor();
    assert.match(await page.getByTestId('services-screen').innerText(), /К777КК 55/);
    assert.match(await page.getByTestId('services-screen').innerText(), /Компакт/);
    assert.equal(await page.getByText('Успешно добавлено').count(), 0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(artifacts, '03-services-handoff.png'), fullPage: true });
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
