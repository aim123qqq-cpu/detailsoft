import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function assertMobileLayout(page, width, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${label}: no horizontal overflow at ${width}px (got ${overflow}px)`);
  const viewport = page.viewportSize();
  const nav = await page.locator('.bottom-nav').boundingBox();
  assert.ok(nav && Math.abs(nav.y + nav.height - viewport.height) < 1, `${label}: bottom navigation stays pinned`);
}

async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
}

test('mobile customer profile: entry points, contact edit with duplicate warning, booking, archive and reactivation', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiCall = async (path, options = {}) => fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...options.headers }
  });
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const card = page.getByTestId('customer-profile');

  try {
    const mariaResponse = await apiCall('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Мария Соколова', phone: '+7 999 111-22-33' }) });
    assert.equal(mariaResponse.status, 201);
    const maria = await mariaResponse.json();
    assert.equal((await apiCall('/api/vehicles', {
      method: 'POST',
      body: JSON.stringify({ customerId: maria.id, catalogVariantId: 'variant_mazda_3_bl_hatch', plateDisplay: 'О321ОО 55', color: 'красный' })
    })).status, 201);

    // Entry point: phone search result.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('main-search').fill('+7 913 123-45-67');
    await page.getByTestId('open-customer-profile-cust_alexey').click();
    await card.waitFor();
    const cardText = await card.innerText();
    assert.match(cardText, /Алексей Морозов/);
    assert.match(cardText, /Mazda 3 BL/);
    assert.match(cardText, /Toyota Camry XV70/);
    assert.match(cardText, /Заказ #history_1/);
    assert.doesNotMatch(cardText, /оплат/i);
    await settle(page);
    await assertMobileLayout(page, 390, 'customer profile');
    await page.screenshot({ path: resolve(artifacts, '53-customer-profile.png') });
    await page.screenshot({ path: resolve(artifacts, '54-customer-profile-full.png'), fullPage: true });

    // Contact edit: a duplicate phone is shown to the user and never merged.
    await page.getByTestId('edit-customer').click();
    await page.getByTestId('customer-phone-input').fill('+7 999 111-22-33');
    await page.getByTestId('save-customer').click();
    await page.getByTestId('customer-duplicate-warning').waitFor();
    assert.match(await page.getByTestId('customer-duplicate-warning').innerText(), /Мария Соколова/);
    await settle(page);
    await page.getByTestId('customer-edit').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '55-customer-duplicate-warning.png') });
    await page.getByTestId('customer-phone-input').fill('+7 913 123-45-67');
    await page.getByTestId('customer-name-input').fill('Алексей Петрович Морозов');
    await page.getByTestId('save-customer').click();
    await page.getByText('✓ Контакты обновлены').waitFor();
    assert.match(await card.innerText(), /Изменены контакты — имя: Алексей Морозов → Алексей Петрович Морозов/);
    const alexeyAfterEdit = await (await apiCall('/api/customers/cust_alexey/profile')).json();
    assert.equal(alexeyAfterEdit.customer.phoneDisplay, '+7 913 123-45-67', 'the rejected duplicate phone was not saved');
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '56-customer-contacts-saved.png') });

    // Vehicle card is reused, and its owner row leads back to the customer card.
    await page.getByTestId('customer-open-vehicle-veh_mazda').click();
    await page.getByTestId('vehicle-profile').waitFor();
    await page.getByTestId('vehicle-owner-profile').click();
    await card.waitFor();
    assert.match(await page.getByTestId('customer-profile-name').innerText(), /Алексей Петрович Морозов/);
    await page.locator('.details-back:visible').click();
    await page.getByTestId('vehicle-profile').waitFor();
    await page.locator('.details-back:visible').click();
    await card.waitFor();

    // Booking from the card keeps the preselected customer through the schedule step.
    await page.getByTestId('customer-book-veh_camry').click();
    await page.getByTestId('services-screen').waitFor();
    assert.match(await page.getByTestId('services-screen').innerText(), /В476РЕ 155/);
    await page.getByTestId('offering-service_wash').locator('.offering-main').click();
    await page.getByTestId('choose-time').click();
    await page.getByTestId('schedule-screen').waitFor();
    await page.locator('[data-testid^="slot-"]:not([disabled])').first().click();
    await page.getByTestId('confirm-booking').click();
    await page.getByTestId('booking-confirmed').waitFor();
    const bookings = (await (await apiCall('/api/bookings?limit=20')).json()).items;
    const cardBooking = bookings.find((item) => item.vehicle.id === 'veh_camry');
    assert.ok(cardBooking, 'booking created from the customer card');
    assert.equal(cardBooking.customer.id, 'cust_alexey');

    // Entry point: booking details. Returning keeps the opened booking.
    await page.getByTestId('bookings-nav').click();
    await page.getByTestId(`booking-card-${cardBooking.id}`).click();
    await page.getByTestId('booking-open-customer').click();
    await card.waitFor();
    assert.match(await card.innerText(), /1\s+запись впереди/);
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '57-customer-from-booking.png') });
    await page.locator('.details-back:visible').click();
    await page.getByTestId('booking-details').waitFor();

    // Entry point: lead linked to an existing customer.
    await page.locator('.details-back:visible').click();
    await page.getByRole('tab', { name: /Обращения/ }).click();
    await page.getByTestId('lead-customer-lead_demo_telegram').click();
    await card.waitFor();
    await page.locator('.details-back:visible').click();
    await page.getByTestId('leads-panel').waitFor();

    // Entry point: order details.
    await page.getByTestId('orders-nav').click();
    await page.getByTestId('order-card-order_history_1').click();
    await page.getByTestId('order-open-customer').click();
    await card.waitFor();

    // Archive is blocked while the customer has an active lead and a confirmed booking.
    await page.getByTestId('open-archive-customer').click();
    await page.getByTestId('confirm-archive-customer').click();
    await page.getByTestId('archive-blockers').waitFor();
    const blockers = await page.getByTestId('archive-blockers').innerText();
    assert.match(blockers, /подтверждённых записей: 1/);
    assert.match(blockers, /активных обращений: 1/);
    await settle(page);
    await page.getByTestId('archive-confirm').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '58-customer-archive-blocked.png') });
    await page.locator('.details-back:visible').click();
    await page.getByTestId('order-details').waitFor();

    // Archive a customer without active work, find them in search, then reactivate.
    await page.getByTestId('new-booking-nav').click();
    await page.getByTestId('main-search').fill('+7 999 111-22-33');
    await page.getByTestId(`open-customer-profile-${maria.id}`).click();
    await card.waitFor();
    await page.getByTestId('open-archive-customer').click();
    await page.getByTestId('confirm-archive-customer').click();
    await page.getByTestId('customer-archived-note').waitFor();
    assert.match(await card.innerText(), /Перенесён в архив/);
    assert.equal(await page.getByTestId('edit-customer').count(), 0, 'archived contacts are read-only');
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '59-customer-archived.png') });

    await page.getByTestId('new-booking-nav').click();
    await page.getByTestId('main-search').fill('+7 999 111-22-33');
    await page.getByTestId('customer-result-archived').waitFor();
    assert.equal(await page.getByTestId('customer-result').count(), 0);
    assert.equal(await page.getByText('Клиент не найден').count(), 0, 'no offer to create a duplicate customer');
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '60-search-archived-customer.png') });
    await page.getByTestId(`open-customer-profile-${maria.id}`).click();
    await page.getByTestId('reactivate-customer').click();
    await page.getByText('✓ Клиент возвращён из архива').waitFor();
    assert.equal(await page.getByTestId('customer-archived-note').count(), 0);

    // Narrow phone and tablet layouts.
    await page.getByTestId('new-booking-nav').click();
    await page.setViewportSize({ width: 320, height: 640 });
    await page.getByTestId('main-search').fill('+7 913 123-45-67');
    await page.getByTestId('open-customer-profile-cust_alexey').click();
    await card.waitFor();
    await settle(page);
    await assertMobileLayout(page, 320, 'customer profile');
    await page.screenshot({ path: resolve(artifacts, '61-customer-profile-320.png'), fullPage: true });
    await page.setViewportSize({ width: 820, height: 1180 });
    await settle(page);
    const tabletOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(tabletOverflow <= 0, `tablet: no horizontal overflow (got ${tabletOverflow}px)`);
    await page.screenshot({ path: resolve(artifacts, '62-customer-profile-tablet.png') });
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
