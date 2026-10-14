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

    await page.getByTestId('open-delivery').click();
    await page.getByTestId('order-delivery').waitFor();
    assert.match(await page.getByTestId('order-delivery').innerText(), /перед выдачей/i);
    assert.doesNotMatch(await page.getByTestId('order-delivery').innerText(), /оплат/i);
    assert.equal(await page.getByTestId('close-order').isDisabled(), false);
    await page.screenshot({ path: resolve(artifacts, '14-order-delivery.png'), fullPage: true });

    await page.getByTestId('close-order').click();
    await page.getByTestId('order-closed').waitFor();
    assert.match(await page.getByTestId('order-closed').innerText(), /заказ закрыт/i);
    await page.screenshot({ path: resolve(artifacts, '15-order-closed.png'), fullPage: true });

    const manageableResponse = await fetch(`http://127.0.0.1:${port}/api/bookings`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer demo-session-token',
        'content-type': 'application/json',
        'idempotency-key': 'e2e-manage-booking'
      },
      body: JSON.stringify({
        customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call',
        startAt: '2026-10-24T09:00:00+03:00',
        selections: [{ type: 'service', id: 'service_wash' }]
      })
    });
    const manageableBooking = await manageableResponse.json();

    await page.getByTestId('bookings-nav').click();
    await page.getByTestId('bookings-workspace').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="bookings-workspace"]')?.textContent?.includes('Алексей Морозов'));
    assert.match(await page.getByTestId('bookings-workspace').innerText(), /Алексей Морозов/);
    assert.match(await page.getByTestId('bookings-workspace').innerText(), /К777КК 55/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(artifacts, '16-bookings-workspace.png'), fullPage: true });

    await page.getByTestId(`booking-card-${manageableBooking.id}`).click();
    await page.getByTestId('booking-details').waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.getByTestId('booking-details').isVisible(), true);
    await page.screenshot({ path: resolve(artifacts, '18-booking-details.png'), fullPage: true });
    await page.getByRole('button', { name: 'Перенести запись' }).click();
    await page.getByLabel('Новая дата').fill('2026-10-27');
    await page.getByRole('button', { name: '12:00' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(artifacts, '19-booking-reschedule.png'), fullPage: true });
    await page.getByRole('button', { name: 'Подтвердить перенос' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="booking-details"]')?.textContent?.includes('27 октября'));
    await page.getByRole('button', { name: 'Отменить запись' }).click();
    await page.getByRole('button', { name: 'Да, отменить' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="booking-details"]')?.textContent?.includes('Отменена'));
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(artifacts, '20-booking-cancelled.png'), fullPage: true });

    await page.getByTestId('orders-nav').click();
    await page.getByTestId('orders-workspace').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="orders-workspace"]')?.textContent?.includes('Алексей Морозов'));
    assert.match(await page.getByTestId('orders-workspace').innerText(), /Алексей Морозов/);
    assert.match(await page.getByTestId('orders-workspace').innerText(), /Закрыт/);
    assert.match(await page.getByTestId('orders-workspace').innerText(), /К777КК 55/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(artifacts, '17-orders-workspace.png'), fullPage: true });

    await page.locator('[data-testid^="order-card-"]', { hasText: 'К777КК 55' }).click();
    await page.getByTestId('order-details').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="order-details"]')?.textContent?.includes('Заказ закрыт'));
    assert.match(await page.getByTestId('order-details').innerText(), /Заказ закрыт/);
    assert.match(await page.getByTestId('order-details').innerText(), /Дмитрий Соколов/);
    assert.match(await page.getByTestId('order-details').innerText(), /5\s100\s₽/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(artifacts, '21-order-details.png') });
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '22-order-history.png') });
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
