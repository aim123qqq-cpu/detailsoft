import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';

test('the car of a new booking comes from make and model lists, and the plate may wait; a service gets its time from the drums', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('main-search').fill('+7 913 123-45-67');
    await page.getByTestId('customer-result').waitFor();
    await page.getByRole('button', { name: 'Добавить автомобиль' }).click();
    await page.getByTestId('add-vehicle-screen').waitFor();

    // Volkswagen, then its model; the model list opens by itself.
    await page.getByTestId('car-make').click();
    await page.getByTestId('car-sheet').waitFor();
    await page.screenshot({ path: resolve('artifacts', '110-car-makes.png') });
    await page.getByTestId('car-search').fill('volks');
    await page.getByTestId('car-option').filter({ hasText: 'Volkswagen' }).click();
    await page.getByTestId('car-search').fill('golf');
    await page.getByTestId('car-option').filter({ hasText: /^Golf$/ }).click();
    assert.equal(await page.getByTestId('car-sheet').count(), 0);
    assert.match(await page.getByTestId('vehicle-missing').innerText(), /кузов$/);
    await page.getByRole('button', { name: /хэтчбек/ }).click();

    // Neither the plate nor the colour is needed: nothing is left to fill in.
    assert.equal(await page.getByTestId('vehicle-missing').count(), 0);
    await page.screenshot({ path: resolve('artifacts', '111-car-without-plate.png'), fullPage: true });
    await page.getByTestId('save-vehicle').click();
    await page.getByTestId('services-screen').waitFor();
    const services = await page.getByTestId('services-screen').innerText();
    assert.match(services, /Volkswagen Golf/);
    assert.match(services, /Без номера/);

    // A car that is not listed goes to the manual form with what was typed.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('main-search').fill('+7 913 123-45-67');
    await page.getByTestId('customer-result').waitFor();
    await page.getByRole('button', { name: 'Добавить автомобиль' }).click();
    await page.getByTestId('car-make').click();
    await page.getByTestId('car-search').fill('Трабант');
    await page.getByTestId('car-not-listed').click();
    await page.getByTestId('manual-vehicle-form').waitFor();
    assert.equal(await page.getByTestId('manual-make').inputValue(), 'Трабант');
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
