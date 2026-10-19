import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';

import { chromePath } from './chrome.mjs';

test('manual vehicle and catalog builder work as one mobile management complex', async () => {
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
    await page.getByRole('button', { name: 'Добавить автомобиль' }).click();
    await page.getByRole('tab', { name: 'Ввести вручную' }).click();
    await page.getByTestId('manual-make').fill('Zeekr');
    await page.getByTestId('manual-model').fill('001');
    await page.getByTestId('manual-body').selectOption('wagon');
    await page.getByTestId('manual-class').selectOption({ label: 'SUV' });
    await page.getByTestId('plate-input').fill('М001ММ 55');
    await page.getByTestId('color-input').fill('серый');
    await page.getByTestId('manual-vehicle-form').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(artifacts, '48-manual-vehicle.png') });

    await page.getByTestId('save-vehicle').click();
    await page.getByTestId('services-screen').waitFor();
    const serviceText = await page.getByTestId('services-screen').innerText();
    assert.match(serviceText, /Zeekr 001/);
    assert.match(serviceText, /SUV/);
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(artifacts, '49-manual-vehicle-services.png') });

    await page.getByTestId('profile-nav').click();
    await page.getByTestId('profile-screen').waitFor();
    await page.getByTestId('catalog-entry').click();
    await page.getByTestId('catalog-manager').waitFor();
    await page.getByTestId('create-catalog-item').click();
    await page.getByTestId('switch-to-composite').click();
    await page.getByTestId('catalog-create').waitFor();
    await page.getByTestId('new-catalog-name').fill('Уход за панорамной крышей');
    await page.getByTestId('new-operation-name').fill('Очистка панорамной крыши');
    await page.getByTestId('create-operation').click();
    await page.getByLabel('Очистка панорамной крыши цена').waitFor();
    await page.getByLabel('Очистка панорамной крыши цена').fill('1800');
    await page.getByLabel('Очистка панорамной крыши длительность').fill('40');
    await page.locator('.operation-create-inline').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(artifacts, '50-catalog-builder.png') });

    await page.getByTestId('save-new-catalog-item').click();
    await page.getByText('Уход за панорамной крышей', { exact: true }).waitFor();
    const card = page.locator('[data-testid^="catalog-card-"]', { hasText: 'Уход за панорамной крышей' });
    assert.match(await card.innerText(), /Услуга/i, 'one operation makes it a simple service');
    assert.doesNotMatch(await card.innerText(), /Своя цена/, 'equal class prices are one base price');
    assert.match(await card.innerText(), /1\s?800/);
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(artifacts, '51-catalog-service-created.png') });

    const nav = await page.locator('.bottom-nav').boundingBox();
    assert.ok(nav && Math.abs(nav.y + nav.height - 844) < 1, 'bottom navigation stays pinned throughout management screens');

    await page.getByTestId('new-booking-nav').click();
    await page.getByRole('button', { name: /По госномеру/ }).click();
    await page.getByTestId('main-search').fill('М001ММ 55');
    const profileLink = page.locator('[data-testid^="open-vehicle-profile-"]');
    await profileLink.waitFor();
    await profileLink.click();
    await page.getByTestId('vehicle-profile').waitFor();
    await page.getByTestId('open-vehicle-spec').click();
    await page.getByTestId('vehicle-spec-editor').waitFor();
    const selectors = page.getByTestId('vehicle-spec-editor').locator('select');
    await selectors.nth(0).selectOption('hatchback');
    await selectors.nth(1).selectOption({ label: 'Компакт' });
    await page.getByTestId('vehicle-spec-editor').scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '52-vehicle-class-correction.png') });
    await page.getByTestId('save-vehicle-spec').click();
    await page.getByText(/Кузов и тарификационный класс обновлены/).waitFor();
    assert.match(await page.getByTestId('open-vehicle-spec').innerText(), /Хэтчбек · класс Компакт/);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
