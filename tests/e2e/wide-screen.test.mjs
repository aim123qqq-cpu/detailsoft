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

    // Management sections name themselves in the header.
    await page.getByTestId('side-settings').click();
    await page.getByRole('heading', { level: 1, name: 'Настройки центра' }).waitFor();
  } finally {
    await browser.close();
    server.close();
  }
});
