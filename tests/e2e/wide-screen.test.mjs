import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';

const pad = (value) => String(value).padStart(2, '0');

test('a wide screen: the side menu, the day grid and a booking opened beside it', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // A booking for tomorrow noon, made through the API.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
  const day = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  const created = await fetch(`${baseUrl}/api/bookings`, {
    method: 'POST', headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', 'idempotency-key': 'wide-screen-1' },
    body: JSON.stringify({ customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt: `${day}T12:00:00+03:00`, selections: [{ type: 'service', id: 'service_wash' }] })
  });
  assert.equal(created.status, 201);
  const booking = await created.json();

  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Europe/Moscow' });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    // The sections are in the side column; the bottom bar is not rendered.
    await page.getByTestId('side-bookings').waitFor();
    assert.equal(await page.getByTestId('bookings-nav').count(), 0);
    await page.getByTestId('side-bookings').click();
    await page.getByTestId('bookings-workspace').waitFor();

    // The day grid opens on today; tomorrow is one click away in the week strip, or the next week.
    if (new Date().getDay() === 0) await page.getByRole('button', { name: 'Следующая неделя' }).click();
    await page.locator('.bw-days button[aria-pressed]', { has: page.locator('strong', { hasText: new RegExp(`^${tomorrow.getDate()}$`) }) }).click();
    const visit = page.getByTestId(`calendar-booking-${booking.id}`);
    await visit.waitFor();
    assert.match(await visit.innerText(), /12:00 · Алексей Морозов/);

    // The booking opens beside the grid, which stays on screen.
    await visit.click();
    await page.getByTestId('booking-details').waitFor();
    assert.equal(await page.getByTestId('booking-calendar').isVisible(), true);
    assert.match(await page.getByTestId('booking-details').innerText(), /Алексей Морозов/);
    await page.getByTestId('booking-composition').waitFor();
    await page.screenshot({ path: resolve('artifacts', '120-wide-bookings-day.png') });

    // Nothing lies over anything: the side panel and the grid do not intersect.
    const grid = await page.locator('.bw-main').boundingBox();
    const side = await page.locator('.bw-side').boundingBox();
    assert.ok(grid.x + grid.width <= side.x, 'the grid ends before the side panel starts');

    // The week: the same booking in its day column.
    await page.getByRole('tab', { name: 'Неделя' }).click();
    await page.locator('.week-grid').waitFor();
    assert.equal(await page.getByTestId(`calendar-booking-${booking.id}`).count(), 1);
    await page.screenshot({ path: resolve('artifacts', '121-wide-bookings-week.png') });

    // Closing the panel leaves the week alone.
    await page.getByRole('button', { name: 'Закрыть запись' }).click();
    assert.equal(await page.getByTestId('booking-details').count(), 0);

    // Orders are a board: a column per stage, the seeded closed order in its own list.
    await page.getByTestId('side-orders').click();
    await page.getByTestId('orders-board').waitFor();
    assert.equal(await page.locator('.orders-column').count(), 5);
    await page.screenshot({ path: resolve('artifacts', '122-wide-orders-board.png') });
    await page.getByRole('button', { name: /^Закрытые/ }).click();
    await page.locator('.orders-closed .order-card').first().click();
    await page.getByTestId('order-details').waitFor();

    // Customers: the whole list, a search by name, and the card one click away.
    await page.getByTestId('side-customers').click();
    await page.getByTestId('customer-row-cust_alexey').waitFor();
    await page.getByTestId('customers-search').fill('zzzz');
    await page.getByText('Никого не нашли').waitFor();
    await page.getByTestId('customers-search').fill('мороз');
    await page.getByTestId('customer-row-cust_alexey').waitFor();
    await page.screenshot({ path: resolve('artifacts', '123-wide-customers.png') });
    await page.getByTestId('customer-row-cust_alexey').click();
    await page.getByRole('heading', { level: 1, name: 'Карточка клиента' }).waitFor();
    await page.getByRole('button', { name: 'Назад' }).first().click();

    // A new booking: customer, services and time stand side by side.
    await page.getByTestId('side-new').click();
    await page.getByTestId('main-search').fill('+7 913 123-45-67');
    await page.locator('.vehicle-card').first().click();
    await page.getByTestId('services-screen').waitFor();
    assert.equal(await page.getByTestId('nb-change-customer').isVisible(), true, 'the chosen customer stays on screen');
    await page.locator('[data-testid^="offering-"]').first().click();
    await page.getByTestId('choose-time').click();
    await page.getByTestId('schedule-screen').waitFor();
    assert.equal(await page.getByTestId('services-screen').isVisible(), true, 'services stay beside the time');
    const services = await page.getByTestId('services-screen').boundingBox();
    const schedule = await page.getByTestId('schedule-screen').boundingBox();
    assert.ok(services.x + services.width <= schedule.x, 'the columns do not overlap');
    await page.screenshot({ path: resolve('artifacts', '124-wide-new-booking.png') });

    // The catalog is a price table, a column per class; a row opens its editor beside the table.
    await page.getByTestId('side-catalog').click();
    await page.getByTestId('catalog-sections').waitFor();
    assert.ok(await page.locator('.catalog-managed-list .catalog-row').count() > 0);
    await page.locator('.catalog-managed-list .catalog-row').first().click();
    await page.locator('.catalog-side .catalog-editor').waitFor();
    const table = await page.locator('.catalog-main').boundingBox();
    const editor = await page.locator('.catalog-side').boundingBox();
    assert.ok(table.x + table.width <= editor.x, 'the table ends before the editor starts');
    await page.screenshot({ path: resolve('artifacts', '125-wide-catalog.png') });
    await page.locator('.catalog-side').getByRole('button', { name: '← Каталог' }).click();
    assert.equal(await page.locator('.catalog-side').count(), 0);

    // Management sections name themselves in the header.
    await page.getByTestId('side-settings').click();
    await page.getByRole('heading', { level: 1, name: 'Настройки центра' }).waitFor();
  } finally {
    await browser.close();
    server.close();
  }
});
