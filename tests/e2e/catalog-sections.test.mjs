import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';

async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
}

test('mobile catalog: sections, a simple service with a class price, and the result in booking', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })).newPage();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('profile-nav').click();
    await page.getByTestId('catalog-entry').click();
    await page.getByTestId('catalog-sections').waitFor();
    const headings = await page.locator('.catalog-section-head h3').allInnerTexts();
    assert.deepEqual([...headings].sort(), ['Детейлинг кузова', 'Комплексы', 'Мойка и уход', 'Салон'], 'existing categories became sections');
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '103-catalog-sections.png') });

    await page.getByTestId('new-section-name').fill('Защитные покрытия');
    await page.getByTestId('create-section').click();
    const section = page.locator('.catalog-section', { has: page.getByRole('heading', { name: 'Защитные покрытия' }) });
    await section.waitFor();
    assert.match(await section.innerText(), /пусто/i);
    assert.equal(await section.locator('[data-testid^="delete-section-"]').count(), 1, 'an empty section can be removed');

    await section.locator('[data-testid^="add-to-section-"]').click();
    await page.getByTestId('simple-service-form').waitFor();
    assert.equal(await page.getByTestId('service-section').locator('option:checked').innerText(), 'Защитные покрытия');
    await page.getByTestId('service-name').fill('Керамика кузова');
    await page.getByTestId('service-duration').fill('240');
    await page.getByTestId('service-amount').fill('25000');
    await page.getByTestId('service-by-class').check();
    await page.getByLabel('SUV цена').fill('32000');
    await page.getByLabel('SUV длительность').fill('300');
    await settle(page);
    await page.getByTestId('service-class-prices').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '104-simple-service-form.png') });
    await page.getByTestId('save-simple-service').click();

    const card = page.locator('[data-testid^="catalog-card-"]', { hasText: 'Керамика кузова' });
    await card.waitFor();
    assert.match(await card.innerText(), /25\s?000[\s\S]*240 мин[\s\S]*Своя цена для 1 класса/);
    await page.locator('.catalog-class-picker button', { hasText: 'SUV' }).click();
    assert.match(await card.innerText(), /32\s?000[\s\S]*300 мин/);

    await section.locator('[data-testid^="rename-section-"]').click();
    await page.getByTestId('section-name-input').fill('Защита кузова');
    await page.getByTestId('save-section-name').click();
    const renamed = page.locator('.catalog-section', { has: page.getByRole('heading', { name: 'Защита кузова' }) });
    await renamed.waitFor();
    await renamed.getByRole('button', { name: 'Поднять раздел «Защита кузова»' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.catalog-section-head h3')].map((node) => node.textContent).indexOf('Защита кузова') === 3);
    await renamed.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '105-catalog-section-renamed.png') });

    // Booking shows the new section and the base price for a mid-size Mazda.
    await page.getByTestId('new-booking-nav').click();
    await page.getByTestId('main-search').fill('+7 913 123-45-67');
    await page.getByTestId('vehicle-veh_mazda').click();
    await page.getByTestId('services-screen').getByText('Керамика кузова').first().waitFor();
    const services = await page.getByTestId('services-screen').innerText();
    assert.match(services, /Защита кузова[\s\S]*Керамика кузова[\s\S]*25\s?000/i);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
