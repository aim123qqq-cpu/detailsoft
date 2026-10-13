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
    const intakeText = await page.getByTestId('order-intake').innerText();
    assert.match(intakeText, /обнаружено при осмотре/i);
    assert.match(intakeText, /переднее крыло/i);
    assert.equal(await page.locator('.inspection-car').count(), 1);
    assert.equal(await page.locator('.zone-rail button').count(), 5);
    await page.locator('.zone-rail').getByRole('button', { name: /Диски/ }).click();
    assert.match(await page.getByTestId('order-intake').innerText(), /передний левый диск/i);
    await page.locator('.zone-rail').getByRole('button', { name: /Кузов/ }).click();
    await page.screenshot({ path: resolve(artifacts, '07-order-intake.png'), fullPage: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    const desktopShell = await page.locator('.app-shell').boundingBox();
    assert.ok(desktopShell && desktopShell.width >= 420 && desktopShell.width <= 440, 'desktop intake keeps realistic phone proportions');
    const zoneFontSize = Number.parseFloat(await page.locator('.zone-rail button').first().evaluate((element) => getComputedStyle(element).fontSize));
    const findingFontSize = Number.parseFloat(await page.locator('.detected-card label').first().evaluate((element) => getComputedStyle(element).fontSize));
    assert.ok(zoneFontSize >= 10, 'zone labels remain readable without widening the phone');
    assert.ok(findingFontSize >= 11, 'inspection findings remain readable without widening the phone');
    await page.screenshot({ path: resolve(artifacts, '07b-order-intake-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });

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

    await page.getByTestId('assign-master').click();
    await page.getByTestId('start-work').waitFor();
    assert.match(await page.getByTestId('order-approved').innerText(), /Дмитрий Соколов/);
    await page.getByTestId('start-work').click();
    await page.getByTestId('master-work').waitFor();
    assert.equal(await page.locator('[data-testid^="work-operation-"]').count(), 2);
    await page.getByTestId('toggle-work-pause').click();
    assert.match(await page.getByTestId('master-work').innerText(), /Пауза/);
    await page.getByTestId('toggle-work-pause').click();
    await page.getByTestId('work-operation-0').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="master-work"]')?.textContent?.includes('1 выполнено'));
    await page.getByTestId('work-operation-1').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="master-work"]')?.textContent?.includes('2 выполнено'));
    assert.match(await page.getByTestId('master-work').innerText(), /2 выполнено/i);
    await page.screenshot({ path: resolve(artifacts, '11-master-work.png'), fullPage: true });

    await page.getByTestId('complete-work').click();
    await page.getByTestId('order-qc').waitFor();
    assert.match(await page.getByTestId('order-qc').innerText(), /финальная проверка/i);
    await page.screenshot({ path: resolve(artifacts, '12-quality-control.png'), fullPage: true });

    await page.getByTestId('qc-pass').click();
    await page.getByTestId('order-ready').waitFor();
    assert.match(await page.getByTestId('order-ready').innerText(), /готов к выдаче/i);
    await page.screenshot({ path: resolve(artifacts, '13-ready-for-delivery.png'), fullPage: true });
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
