import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { openDatabase } from '../../server/db.mjs';
import { chromePath } from './chrome.mjs';
import { acceptLegal } from './offline-helpers.mjs';

test('the bell shows unread reminders, the feed opens and reads them, the owner sets the center\'s reminders', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'df-notifications-'));
  const databasePath = join(folder, 'detailflow.db');
  const server = createDetailFlowServer({ databasePath, seed: true, staticDir: resolve('dist'), authTokens: new Map([
    ['owner-token', { tenantId: 'tenant_demo', displayName: 'Анна Смирнова', roles: ['owner', 'admin'], memberId: 'member_demo_owner' }]
  ]) });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await acceptLegal(baseUrl, 'owner-token');
  // Two reminders already delivered by the minute timer (its rules have their own tests).
  const db = openDatabase(databasePath, { seed: false });
  const insert = db.prepare(`INSERT INTO notifications (id, tenant_id, member_id, kind, title, body, link) VALUES (?, 'tenant_demo', 'member_demo_owner', ?, ?, ?, ?)`);
  insert.run('ntf_1', 'booking_reminder', 'Через 1 час запись', '12:00 · Toyota Camry · 1 ч 30 мин', '/bookings/bk_1');
  insert.run('ntf_2', 'day_plan', 'План на сегодня: 2 записи', '10:00 · Toyota Camry · 1 ч 30 мин\n16:30 · Mazda 3 · 45 мин', '/bookings');
  db.close();

  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => localStorage.setItem('detailflow.session', 'owner-token'));
  const page = await context.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const bell = page.getByTestId('notifications-bell');
    await bell.locator('.bell-badge').waitFor();
    assert.equal(await bell.locator('.bell-badge').innerText(), '2');
    await page.screenshot({ path: resolve('artifacts', '98-notifications-bell.png') });

    await bell.click();
    await page.getByTestId('notification').first().waitFor();
    assert.equal(await page.getByTestId('notification').count(), 2);
    assert.match(await page.getByTestId('notifications-screen').innerText(), /Через 1 час запись[\s\S]*12:00 · Toyota Camry/);
    await page.screenshot({ path: resolve('artifacts', '99-notifications-feed.png'), fullPage: true });
    // Opening the feed reads it.
    await page.waitForFunction(async () => (await (await fetch('/api/notifications', { headers: { authorization: 'Bearer owner-token' } })).json()).unread === 0);
    assert.equal(await page.locator('.bell-badge').count(), 0, 'the badge is gone');

    await page.getByTestId('pref-viaMessenger').uncheck();
    await page.waitForFunction(async () => (await (await fetch('/api/notifications/preferences', { headers: { authorization: 'Bearer owner-token' } })).json()).viaMessenger === false);

    // A reminder opens the bookings.
    await page.getByTestId('notification').first().click();
    await page.getByTestId('bookings-workspace').waitFor();

    // The owner sets the center's reminders in the settings.
    await page.getByTestId('profile-nav').click();
    await page.getByTestId('center-settings-entry').click();
    await page.getByTestId('reminders-panel').waitFor();
    await page.getByTestId('reminders-panel').getByRole('button', { name: '30 мин' }).click();
    await page.getByTestId('reminder-evening').check();
    await page.getByTestId('save-reminders').click();
    await page.getByTestId('reminders-panel').getByText('Напоминания сохранены').waitFor();
    const saved = await (await fetch(`${baseUrl}/api/tenants/current/reminders`, { headers: { authorization: 'Bearer owner-token' } })).json();
    assert.equal(saved.beforeMinutes, 30);
    assert.equal(saved.evening.enabled, true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
    await rm(folder, { recursive: true, force: true });
  }
});
