import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';

test('landing22: the intake diagram works, the network switch flips, and the search is handed to the app', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    await page.goto(`${baseUrl}/landing22`, { waitUntil: 'networkidle' });
    assert.equal(new URL(page.url()).pathname, '/landing22/');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no sideways scroll on a phone');

    // The page draws the app's own diagram: same numbers as the intake screen.
    assert.equal(await page.locator('#diagram [aria-label="2. Капот"]').count(), 1);
    assert.equal(await page.locator('#findings li').count(), 2);
    await page.locator('#diagram [aria-label="11. Левое заднее крыло"]').click();
    await page.locator('#editor').getByRole('button', { name: 'Вмятина' }).click();
    await page.locator('#editor').getByRole('radio', { name: 'Сильное' }).click();
    await page.locator('#editor').getByRole('button', { name: 'Добавить замечание' }).click();
    assert.equal(await page.locator('#findings li').count(), 3);
    assert.match(await page.locator('#findings').innerText(), /11\s+Левое заднее крыло\s+Вмятина/);
    assert.match(await page.locator('#diagram [aria-label="11. Левое заднее крыло"]').getAttribute('class'), /severity-high/);
    await page.locator('#body-types').getByRole('radio', { name: 'Купе' }).click();
    assert.equal(await page.locator('#diagram [aria-label="9. Левая дверь"]').count(), 1, 'a coupe has one door per side');

    const network = page.locator('#net-switch');
    await network.scrollIntoViewIfNeeded();
    await network.click();
    assert.equal(await network.getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#net-word').innerText(), 'вернулась');

    await page.locator('#start-form').scrollIntoViewIfNeeded();
    await page.locator('#start-form').getByRole('button', { name: 'Найти клиента' }).click();
    await page.getByTestId('main-search').waitFor();
    assert.equal(await page.getByTestId('main-search').inputValue(), '+7 913 123-45-67');
    assert.equal(new URL(page.url()).search, '', 'the handed search is dropped from the address');
    await page.getByTestId('customer-result').waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
