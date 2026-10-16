import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';

import { chromePath } from './chrome.mjs';

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
    const firstFocusableClass = await page.locator('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').first().getAttribute('class');
    assert.match(firstFocusableClass ?? '', /skip-link/, 'skip link is first in the keyboard focus order');
    await page.locator('.skip-link').focus();
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('skip-link')), true, 'skip link accepts keyboard focus');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content');

    const searchTargets = await page.locator('.search-tabs button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
    assert.ok(searchTargets.every((height) => height >= 43.99), `search tabs meet the 44px touch target within browser subpixel precision: ${searchTargets.join(', ')}`);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedAnimation = Number.parseFloat(await page.locator('.screen').evaluate((element) => getComputedStyle(element).animationDuration));
    assert.ok(reducedAnimation <= 0.01, 'screen animation respects reduced motion');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await context.setOffline(true);
    await page.getByTestId('offline-banner').waitFor();
    assert.match(await page.getByTestId('offline-banner').innerText(), /нет подключения/i);
    await page.screenshot({ path: resolve(artifacts, '28-offline-banner.png') });
    await context.setOffline(false);
    await page.getByTestId('offline-banner').waitFor({ state: 'hidden' });

    await page.route('**/api/customers?*', (route) => route.abort('connectionfailed'));
    await page.getByTestId('main-search').fill('+7 913 123-45-67');
    await page.getByTestId('search-retry').waitFor();
    assert.match(await page.getByTestId('search-feedback').innerText(), /не удалось связаться с сервером/i);
    assert.equal(await page.getByTestId('main-search').inputValue(), '+7 913 123-45-67');
    await page.screenshot({ path: resolve(artifacts, '29-search-network-error.png') });
    await page.unroute('**/api/customers?*');
    await page.getByTestId('search-retry').click();
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

    await page.getByTestId('defect-photo-input').setInputFiles(resolve(artifacts, '07-order-intake.png'));
    await page.locator('.inspection-photo-row img').waitFor();
    await page.getByRole('button', { name: /^Фото/ }).click();
    await page.getByTestId('intake-photo-input').setInputFiles(resolve(artifacts, '06-booking-confirmed.png'));
    await page.locator('.photo-grid img').nth(1).waitFor();
    assert.equal(await page.locator('.photo-grid img').count(), 2);
    assert.match(await page.locator('.photo-tab-panel').innerText(), /Переднее крыло/);
    await page.screenshot({ path: resolve(artifacts, '30-intake-photos.png'), fullPage: true });
    await page.getByRole('button', { name: 'Осмотр' }).click();

    await page.setViewportSize({ width: 820, height: 1024 });
    const tabletShell = await page.locator('.app-shell').boundingBox();
    assert.ok(tabletShell && tabletShell.width >= 760 && tabletShell.width <= 800, 'tablet uses the available width with safe outer gutters');
    const intakeColumns = await page.locator('.inspection-board').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    assert.equal(intakeColumns, 3, 'tablet intake separates zones, vehicle and defect details');
    const zoneFontSize = Number.parseFloat(await page.locator('.zone-rail button').first().evaluate((element) => getComputedStyle(element).fontSize));
    const findingFontSize = Number.parseFloat(await page.locator('.detected-card label').first().evaluate((element) => getComputedStyle(element).fontSize));
    const tabletNav = await page.locator('.bottom-nav').boundingBox();
    assert.ok(zoneFontSize >= 11, 'zone labels remain readable on tablet');
    assert.ok(findingFontSize >= 12, 'inspection findings remain readable on tablet');
    assert.ok(tabletNav && Math.abs(tabletNav.y + tabletNav.height - 1024) < 1, 'bottom navigation remains pinned on tablet');
    await page.screenshot({ path: resolve(artifacts, '26-order-intake-tablet.png') });
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
    assert.match(await page.getByTestId('master-work').innerText(), /Пауза/i);
    await page.getByTestId('toggle-work-pause').click();
    await page.getByTestId('work-operation-0').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="master-work"]')?.textContent?.includes('1 выполнено'));
    await page.getByTestId('work-operation-1').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="master-work"]')?.textContent?.includes('2 выполнено'));
    assert.match(await page.getByTestId('master-work').innerText(), /2 выполнено/i);
    await page.screenshot({ path: resolve(artifacts, '11-master-work.png'), fullPage: true });

    await page.getByTestId('complete-work').click();
    await page.getByTestId('order-ready').waitFor();
    assert.match(await page.getByTestId('order-ready').innerText(), /готов к выдаче/i);
    assert.equal(await page.getByTestId('order-qc').count(), 0);
    await page.screenshot({ path: resolve(artifacts, '13-ready-for-delivery.png'), fullPage: true });

    await page.getByTestId('open-delivery').click();
    await page.getByTestId('order-delivery').waitFor();
    assert.match(await page.getByTestId('order-delivery').innerText(), /перед выдачей/i);
    assert.doesNotMatch(await page.getByTestId('order-delivery').innerText(), /оплат/i);
    assert.equal(await page.getByTestId('close-order').isDisabled(), true);
    assert.match(await page.getByTestId('order-delivery').innerText(), /добавьте фото до и после/i);
    await page.getByTestId('result-photo-input').setInputFiles(resolve(artifacts, '11-master-work.png'));
    await page.locator('.delivery-photos img').nth(1).waitFor();
    assert.equal(await page.getByTestId('close-order').isDisabled(), true);
    await page.getByRole('button', { name: 'Клиент осмотрел результат работ' }).click();
    await page.getByRole('button', { name: 'Комплектность автомобиля проверена' }).click();
    assert.equal(await page.getByTestId('close-order').isDisabled(), false);
    await page.screenshot({ path: resolve(artifacts, '31-order-delivery-photos.png'), fullPage: true });

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

    await page.getByRole('tab', { name: 'День' }).click();
    await page.getByLabel('Дата календаря').fill('2026-10-24');
    await page.getByTestId(`calendar-booking-${manageableBooking.id}`).waitFor();
    assert.match(await page.getByTestId('booking-calendar').innerText(), /1\s+визит/);
    await page.screenshot({ path: resolve(artifacts, '43-booking-calendar-day.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Неделя' }).click();
    await page.getByTestId(`calendar-booking-${manageableBooking.id}`).waitFor();
    assert.equal(await page.locator('.calendar-week-strip button').count(), 7);
    await page.screenshot({ path: resolve(artifacts, '44-booking-calendar-week.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Список' }).click();

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

    await page.getByRole('button', { name: '← Все записи' }).click();
    await page.getByRole('tab', { name: /Обращения/ }).click();
    await page.getByTestId('leads-panel').waitFor();
    assert.match(await page.getByTestId('leads-panel').innerText(), /Алексей Морозов/);
    assert.match(await page.getByTestId('leads-panel').innerText(), /Telegram/);
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '32-leads-inbox.png'), fullPage: true });

    await page.getByTestId('lead-card-lead_demo_telegram').getByRole('button', { name: /В запись/ }).click();
    await page.locator('.lead-conversion-banner').waitFor();
    await page.getByTestId('customer-result').waitFor();
    assert.equal(await page.getByTestId('main-search').inputValue(), '+7 913 123-45-67');
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '33-lead-conversion.png'), fullPage: true });
    await page.getByTestId('vehicle-veh_mazda').click();
    await page.getByTestId('services-screen').waitFor();
    await page.getByTestId('offering-service_wash').locator('.offering-main').click();
    await page.getByTestId('choose-time').click();
    await page.getByTestId('schedule-screen').waitFor();
    await page.getByTestId('slot-18:00').click();
    await page.getByTestId('confirm-booking').click();
    await page.getByTestId('booking-confirmed').waitFor();

    await page.getByTestId('bookings-nav').click();
    await page.getByRole('tab', { name: /Обращения/ }).click();
    await page.getByRole('button', { name: 'Все' }).click();
    await page.getByTestId('lead-card-lead_demo_telegram').waitFor();
    assert.match(await page.getByTestId('lead-card-lead_demo_telegram').innerText(), /Запись создана/);
    assert.match(await page.getByTestId('lead-card-lead_demo_telegram').innerText(), /Связано с записью/);
    await page.screenshot({ path: resolve(artifacts, '34-lead-converted.png'), fullPage: true });

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

    assert.equal(await page.locator('.bottom-nav button').count(), 5);
    assert.deepEqual(await page.locator('.bottom-nav button').allTextContents(), ['Статистика', 'Записи', '', 'Заказы', 'Профиль']);
    assert.equal(await page.getByTestId('new-booking-nav').getAttribute('aria-label'), 'Новая запись');
    await page.getByTestId('analytics-nav').click();
    await page.getByTestId('analytics-screen').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="analytics-screen"]')?.textContent?.includes('Согласовано по сметам'));
    const analyticsText = await page.getByTestId('analytics-screen').innerText();
    assert.match(analyticsText, /Пульс центра/);
    assert.match(analyticsText, /согласовано по сметам/i);
    assert.doesNotMatch(analyticsText, /оплат|выруч/i);
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(artifacts, '23-analytics.png') });
    await page.getByText('Статусы заказов').scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '24-analytics-details.png') });

    await page.getByTestId('profile-nav').click();
    await page.getByTestId('profile-screen').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="profile-screen"]')?.textContent?.includes('Клиенты и автомобили'));
    assert.match(await page.getByTestId('profile-screen').innerText(), /DetailFlow Studio/);
    assert.match(await page.getByTestId('profile-screen').innerText(), /Администратор/);
    assert.match(await page.getByTestId('profile-screen').innerText(), /Контроль качества временно отключён/);
    assert.match(await page.getByTestId('profile-screen').innerText(), /Права вычисляются сервером/);
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '25-profile.png') });

    await page.getByTestId('catalog-entry').click();
    await page.getByTestId('catalog-manager').waitFor();
    assert.match(await page.getByTestId('catalog-manager').innerText(), /Услуги и цены/);
    assert.match(await page.getByTestId('catalog-card-service_wash').innerText(), /Бережная мойка/);
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '35-catalog-manager.png') });
    await page.getByTestId('catalog-card-service_wash').getByRole('button', { name: 'Редактировать' }).click();
    await page.getByTestId('catalog-editor').waitFor();
    await page.screenshot({ path: resolve(artifacts, '36-catalog-editor.png') });
    await page.getByLabel('Предварительная мойка цена').fill('450');
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '37-catalog-prices.png') });
    await page.getByTestId('save-catalog-item').click();
    await page.getByTestId('catalog-manager').waitFor();
    assert.match(await page.getByTestId('catalog-card-service_wash').innerText(), /1\s?770\s?₽/);
    await page.getByRole('button', { name: '← Профиль' }).click();
    await page.getByTestId('profile-screen').waitFor();

    await page.getByTestId('center-settings-entry').click();
    await page.getByTestId('center-settings-screen').waitFor();
    assert.match(await page.getByTestId('center-settings-screen').innerText(), /График и загрузка/);
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '38-center-settings.png') });
    await page.getByRole('button', { name: 'Суббота' }).click();
    await page.getByRole('button', { name: 'Воскресенье' }).click();
    await page.getByLabel('Время открытия').fill('10:00');
    await page.getByLabel('Время закрытия').fill('19:00');
    await page.getByRole('button', { name: '60 мин' }).click();
    await page.getByRole('button', { name: 'Увеличить вместимость' }).click();
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '39-center-capacity.png') });
    await page.getByTestId('save-center-settings').click();
    await page.getByText(/График сохранён/).waitFor();
    await page.getByRole('button', { name: '← Профиль' }).click();
    await page.getByTestId('profile-screen').waitFor();

    await page.getByTestId('team-entry').click();
    await page.getByTestId('team-screen').waitFor();
    assert.match(await page.getByTestId('team-screen').innerText(), /Команда и роли/);
    await page.getByText('Дмитрий Соколов', { exact: true }).waitFor();
    assert.match(await page.getByTestId('team-screen').innerText(), /Дмитрий Соколов/);
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(artifacts, '40-team.png') });
    await page.getByTestId('add-team-member').click();
    await page.getByLabel('Имя сотрудника').fill('Мария Орлова');
    await page.getByRole('button', { name: /Мастер/ }).click();
    await page.screenshot({ path: resolve(artifacts, '41-team-member-form.png') });
    await page.getByTestId('create-team-member').click();
    await page.getByTestId('team-access-token').waitFor();
    assert.match(await page.getByTestId('team-access-token').innerText(), /df_[a-f0-9]{48}/);
    await page.screenshot({ path: resolve(artifacts, '42-team-access-token.png') });
    await page.getByRole('button', { name: 'Готово' }).click();
    assert.match(await page.getByTestId('team-screen').innerText(), /Мария Орлова/);
    await page.getByRole('button', { name: '← Профиль' }).click();
    await page.getByTestId('profile-screen').waitFor();

    await page.setViewportSize({ width: 820, height: 1024 });
    const profileColumns = await page.getByTestId('profile-screen').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    assert.equal(profileColumns, 2, 'tablet profile uses two readable content columns');
    const tabletProfileNav = await page.locator('.bottom-nav').boundingBox();
    assert.ok(tabletProfileNav && Math.abs(tabletProfileNav.y + tabletProfileNav.height - 1024) < 1, 'profile navigation remains pinned on tablet');
    await page.screenshot({ path: resolve(artifacts, '27-profile-tablet.png') });

    await page.setViewportSize({ width: 320, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const navTargets = await page.locator('.bottom-nav button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
    assert.ok(navTargets.every((height) => height >= 44), 'all five navigation targets remain touch-friendly at 320px');
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
