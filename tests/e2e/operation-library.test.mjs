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

test('mobile operation library: search, usage, protected archive, rename and restore', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    // Search shows real visits (closed orders), matching the customer card.
    await page.getByTestId('main-search').fill('+7 913 123-45-67');
    await page.getByTestId('customer-result').waitFor();
    assert.match(await page.getByTestId('customer-result').innerText(), /· 1 визит\n/);

    await page.getByTestId('profile-nav').click();
    await page.getByTestId('catalog-entry').click();
    await page.getByTestId('catalog-operations-tab').click();
    await page.getByTestId('operation-library').waitFor();
    assert.match(await page.getByTestId('operation-row-op_prewash').innerText(), /1 услуга · 1 пакет/);

    await page.getByTestId('operation-search').fill('МОЙК');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('[data-testid^="operation-row-"]').count(), 2);
    await settle(page);
    await page.getByTestId('operation-library').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '82-operation-library.png') });

    // An operation used by active items cannot be archived; the reason is shown.
    await page.getByTestId('operation-edit-op_prewash').click();
    const archive = page.getByTestId('archive-operation');
    assert.equal(await archive.isDisabled(), true);
    assert.match(await archive.innerText(), /В архив нельзя/);
    assert.match(await page.getByTestId('operation-row-op_prewash').innerText(), /Бережная мойка, Комплексный уход/);
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '83-operation-protected.png') });

    // Rename a used operation.
    await page.getByTestId('operation-search').fill('');
    await page.getByTestId('operation-edit-op_dry').click();
    await page.getByTestId('operation-name-input').fill('Сушка кузова микрофиброй');
    await page.getByTestId('save-operation').click();
    await page.getByText(/Название обновлено/).waitFor();
    assert.match(await page.getByTestId('operation-row-op_dry').innerText(), /Сушка кузова микрофиброй/);

    // Add, archive and restore an unused operation.
    await page.getByTestId('new-operation-name').fill('Озонирование салона');
    await page.getByTestId('create-operation').click();
    const created = page.locator('[data-testid^="operation-row-"]', { hasText: 'Озонирование салона' });
    await created.waitFor();
    assert.match(await created.innerText(), /Не используется/);
    await created.getByRole('button', { name: 'Изменить' }).click();
    await page.getByTestId('archive-operation').click();
    await page.getByText(/перенесена в архив/).waitFor();
    assert.equal(await created.count(), 0, 'archived operations leave the active list');
    await page.getByRole('button', { name: /^Архив/ }).click();
    await created.waitFor();
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '84-operation-archived.png') });
    await created.getByRole('button', { name: 'Изменить' }).click();
    await page.getByTestId('restore-operation').click();
    await page.getByText(/Операция восстановлена/).waitFor();

    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `operation library has no horizontal overflow at 320px (got ${overflow}px)`);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
