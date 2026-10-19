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

async function assertMobileLayout(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${label}: no horizontal overflow (got ${overflow}px)`);
  const nav = await page.locator('.bottom-nav').boundingBox();
  assert.ok(nav && Math.abs(nav.y + nav.height - 844) < 1, `${label}: bottom navigation stays pinned`);
}

test('mobile booking composition revision keeps the previous quote and rechecks the slot', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let keyCounter = 0;
  const apiCall = async (path, options = {}) => fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...options.headers }
  });
  const book = async (vehicleId, startAt) => {
    const response = await apiCall('/api/bookings', {
      method: 'POST',
      headers: { 'idempotency-key': `e2e-composition-${keyCounter += 1}` },
      body: JSON.stringify({ customerId: 'cust_alexey', vehicleId, channel: 'call', startAt, selections: [{ type: 'service', id: 'service_wash' }] })
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });

  try {
    const booking = await book('veh_mazda', '2026-12-22T12:00:00+03:00');
    const crowded = await book('veh_mazda', '2026-12-23T09:00:00+03:00');
    await book('veh_camry', '2026-12-23T10:00:00+03:00');
    await book('veh_camry', '2026-12-23T10:00:00+03:00');

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('bookings-nav').click();
    await page.getByTestId(`booking-card-${booking.id}`).click();
    await page.getByTestId('booking-composition').waitFor();
    const composition = await page.getByTestId('booking-composition').innerText();
    assert.match(composition, /Расчёт v1/);
    assert.match(composition, /Бережная мойка/);
    await settle(page);
    await assertMobileLayout(page, 'booking details');
    await page.screenshot({ path: resolve(artifacts, '63-booking-composition.png'), fullPage: true });

    // Rebuild the composition with the existing services catalog screen.
    await page.getByTestId('edit-composition').click();
    await page.getByTestId('services-screen').waitFor();
    assert.equal(await page.getByTestId('offering-service_wash').locator('.offering-main').getAttribute('aria-pressed'), 'true');
    await page.getByTestId('offering-service_wash').locator('.offering-main').click();
    await page.getByTestId('offering-package_complex').locator('.offering-main').click();
    await page.locator('.quote-dock').getByText(/4\s?900/).waitFor();
    await page.getByTestId('review-composition').click();
    await page.getByTestId('composition-review').waitFor();
    const review = await page.getByTestId('composition-review').innerText();
    assert.match(review, /v2/);
    assert.match(review, /Комплексный уход/);
    assert.match(review, /Бережная мойка/);
    assert.match(await page.getByTestId('composition-delta').innerText(), /\+3\s?500.*\+85 мин/);
    await page.getByTestId('composition-reason').fill('Клиент добавил салон');
    await settle(page);
    await page.getByTestId('composition-review').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '64-booking-composition-review.png') });

    await page.getByTestId('save-composition').click();
    await page.getByText(/Состав обновлён: расчёт v2/).waitFor();
    const details = await page.getByTestId('booking-details').innerText();
    assert.match(details, /4\s?900/);
    assert.match(details, /120 мин/);
    await page.getByTestId('composition-history').locator('summary').click();
    const history = await page.getByTestId('composition-history').innerText();
    assert.match(history, /v2 · текущая/);
    assert.match(history, /v1/);
    assert.match(history, /Клиент добавил салон/);
    await settle(page);
    await assertMobileLayout(page, 'booking details after revision');
    await page.getByTestId('booking-composition').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '65-booking-composition-history.png') });

    const stored = await (await apiCall(`/api/bookings/${booking.id}`)).json();
    assert.equal(stored.quoteVersion, 2);
    assert.deepEqual(stored.quoteVersions.map((version) => version.totalAmountMinor), [booking.preliminaryAmountMinor, 490000]);

    // A longer composition that no longer fits the slot is refused, with a path to reschedule.
    await page.locator('.details-back:visible').click();
    await page.getByTestId(`booking-card-${crowded.id}`).click();
    await page.getByTestId('edit-composition').click();
    await page.getByTestId('offering-package_complex').locator('.offering-main').click();
    await page.locator('.quote-dock').getByText(/4\s?900/).waitFor();
    await page.getByTestId('review-composition').click();
    await page.getByTestId('save-composition').click();
    await page.getByText(/не помещается в выбранное время/).waitFor();
    await settle(page);
    await page.getByTestId('composition-review').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '66-booking-composition-slot-conflict.png') });
    const unchanged = await (await apiCall(`/api/bookings/${crowded.id}`)).json();
    assert.equal(unchanged.quoteVersion, 1);

    // One step: pick a time where the new duration fits and save composition and time together.
    await page.getByTestId('composition-new-time').waitFor();
    assert.equal(await page.getByTestId('save-composition').isDisabled(), true, 'a time has to be picked first');
    const slot = page.locator('[data-testid^="composition-slot-"]:not([disabled])').first();
    await slot.click();
    assert.match(await page.getByTestId('save-composition').innerText(), /и перенести/);
    await settle(page);
    await page.getByTestId('composition-new-time').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '114-composition-with-new-time.png') });
    await page.getByTestId('save-composition').click();
    await page.getByText(/запись перенесена/).waitFor();
    const moved = await (await apiCall(`/api/bookings/${crowded.id}`)).json();
    assert.equal(moved.quoteVersion, 2);
    assert.notEqual(moved.startAt, unchanged.startAt);
    assert.equal(moved.estimatedDurationMinutes, moved.quoteVersions.at(-1).totalDurationMinutes);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
