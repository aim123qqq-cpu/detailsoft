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
    assert.match(await page.locator('#act-list').innerText(), /11\s+Левое заднее крыло · сильное — Вмятина/, 'the act below carries the finding with the same number');
    await page.locator('#act-paper').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('#act-paper')?.dataset.step === '3', null, { timeout: 5000 });
    await page.locator('#top').scrollIntoViewIfNeeded();
    await page.locator('#body-types').getByRole('radio', { name: 'Купе' }).click();
    assert.equal(await page.locator('#diagram [aria-label="9. Левая дверь"]').count(), 1, 'a coupe has one door per side');

    const network = page.locator('#net-switch');
    await network.scrollIntoViewIfNeeded();
    await network.click();
    assert.equal(await network.getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#net-word').innerText(), 'вернулась');

    // Roles: the permissions the server grants, the role's own screen.
    await page.locator('#role-tabs').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#perms li.on').count(), 2, 'a master performs work and takes orders');
    await page.locator('#role-tabs').getByRole('tab', { name: 'Приёмщик' }).click();
    assert.deepEqual(await page.locator('#perms li.on b').allInnerTexts(), ['Приёмка']);
    await page.waitForFunction(() => document.querySelector('#role-shot')?.getAttribute('src') === 'img/intake.jpg');
    await page.locator('#role-tabs').getByRole('tab', { name: 'Владелец' }).click();
    assert.equal(await page.locator('#perms li.on').count(), 11, 'the owner has every right except being an executor, plus the team');

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
