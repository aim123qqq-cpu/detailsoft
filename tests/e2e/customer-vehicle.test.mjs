import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

test('mobile customer → vehicle → services → booking flow works end to end', async () => {
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

    await page.getByTestId('offering-package_complex').locator('.offering-main').click();
    await page.getByTestId('offering-service_wash').locator('.offering-main').click();
    await page.getByText(/операции из пакета исключены/).waitFor();
    assert.match(await page.locator('.quote-dock').innerText(), /4\s?200/);
    assert.match(await page.getByTestId('offering-service_wash').innerText(), /В пакете/);
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '04-services-quote.png') });

    await page.getByTestId('choose-time').click();
    await page.getByTestId('schedule-screen').waitFor();
    await page.getByTestId('slot-16:00').click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '05-booking-time.png') });

    await page.getByTestId('confirm-booking').click();
    await page.getByTestId('booking-confirmed').waitFor();
    assert.match(await page.getByTestId('booking-confirmed').innerText(), /запись подтверждена/i);
    assert.match(await page.getByTestId('booking-confirmed').innerText(), /4\s?200/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(artifacts, '06-booking-confirmed.png') });

    await page.getByTestId('start-intake').click();
    await page.getByTestId('order-intake').waitFor();
    assert.match(await page.getByTestId('order-intake').innerText(), /зафиксируйте приёмку/i);
    await page.screenshot({ path: resolve(artifacts, '07-order-intake.png'), fullPage: true });

    await page.getByTestId('save-intake').click();
    await page.getByTestId('order-estimate').waitFor();
    assert.match(await page.getByTestId('order-estimate').innerText(), /проверьте состав работ/i);
    assert.match(await page.getByTestId('order-estimate').innerText(), /5\s?100/);
    await page.screenshot({ path: resolve(artifacts, '08-estimate-draft.png'), fullPage: true });

    await page.getByTestId('create-estimate').click();
    await page.getByTestId('order-approval').waitFor();
    assert.match(await page.getByTestId('order-approval').innerText(), /смета v1/i);
    await page.screenshot({ path: resolve(artifacts, '09-estimate-approval.png'), fullPage: true });

    await page.getByTestId('approve-estimate').click();
    await page.getByTestId('order-approved').waitFor();
    assert.match(await page.getByTestId('order-approved').innerText(), /готов к передаче мастеру/i);
    assert.match(await page.getByTestId('order-approved').innerText(), /Анна, администратор/);
    await page.screenshot({ path: resolve(artifacts, '10-order-approved.png'), fullPage: true });
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
