import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';

import { chromePath } from './chrome.mjs';

function fakeAdapter(provider, title, botName) {
  return {
    provider, title, botName, sent: [], handler: null,
    deepLink(payload) { return `https://bots.example/${botName}?start=${payload}`; },
    async start(handler) { this.handler = handler; },
    stop() {},
    async sendMessage(userId, text, buttons) { this.sent.push({ userId, text, buttons }); },
    async answerCallback() {}
  };
}

async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
}

test('mobile messenger sign-in: owner invite, bot confirmation, session and sign-out', async () => {
  const telegram = fakeAdapter('telegram', 'Telegram', 'detailflow_demo_bot');
  const max = fakeAdapter('max', 'MAX', 'detailflow_max_bot');
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist'), messengers: [telegram, max] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });

  try {
    // With a configured bot the app opens on the sign-in screen; demo access is an explicit choice.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('login-telegram').waitFor();
    assert.equal(await page.locator('.bottom-nav').count(), 0, 'navigation is hidden until sign-in');
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '74-login-providers.png') });
    await page.screenshot({ path: resolve(artifacts, '74-login-providers-full.png'), fullPage: true });
    for (const [width, height, name] of [[320, 640, '78-login-320.png'], [820, 1180, '79-login-tablet.png']]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `sign-in screen has no horizontal overflow at ${width}px (got ${overflow}px)`);
      await page.screenshot({ path: resolve(artifacts, name), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('login-cancel').click();

    // Owner invites an employee (here: the owner's own member card) into Telegram.
    await page.getByTestId('profile-nav').click();
    await page.getByTestId('team-entry').click();
    await page.getByRole('button', { name: 'Настроить Анна Смирнова' }).click();
    await page.getByTestId('messenger-access').waitFor();
    await page.getByTestId('invite-telegram').click();
    const inviteLink = await page.getByTestId('invite-link').innerText();
    assert.match(inviteLink, /start=invite_[0-9a-f]{24}$/);
    await settle(page);
    await page.getByTestId('messenger-invite').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '73-team-messenger-invite.png') });

    await telegram.handler({ provider: 'telegram', kind: 'start', userId: '1001', displayName: 'Анна', payload: new URL(inviteLink).searchParams.get('start') });
    assert.match(telegram.sent.at(-1).text, /привязан к сотруднику «Анна Смирнова»/);

    // Sign in from the profile.
    await page.getByRole('button', { name: '← Команда' }).click();
    await page.getByRole('button', { name: '← Профиль' }).click();
    assert.match(await page.getByTestId('profile-signin').innerText(), /Демо-доступ/);
    await page.getByTestId('sign-in-messenger').click();
    await page.getByTestId('login-telegram').waitFor();
    await page.getByTestId('login-telegram').click();
    const code = await page.getByTestId('login-code').getAttribute('data-code');
    assert.match(code, /^[A-Z2-9]{6}$/);
    const botHref = await page.getByTestId('open-bot').getAttribute('href');
    assert.match(botHref, /^https:\/\/bots\.example\/detailflow_demo_bot\?start=login_[0-9a-f]{32}$/);
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '75-login-code.png') });
    // Regression: the user needs time in the bot, so several polls return the same status in a row.
    await page.waitForTimeout(3500);

    await telegram.handler({ provider: 'telegram', kind: 'start', userId: '1001', displayName: 'Анна', payload: new URL(botHref).searchParams.get('start') });
    const prompt = telegram.sent.at(-1);
    assert.match(prompt.text, new RegExp(code), 'the bot shows the same code as the screen');
    await page.getByText('Подтвердите вход кнопкой').waitFor();
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '76-login-awaiting-confirmation.png') });
    await page.waitForTimeout(3500);

    await Promise.all([
      page.waitForEvent('load'),
      telegram.handler({ provider: 'telegram', kind: 'callback', userId: '1001', payload: prompt.buttons[0][0].payload, callbackId: 'cb' })
    ]);
    const stored = await page.evaluate(() => localStorage.getItem('detailflow.session'));
    assert.match(stored, /^dfs_[0-9a-f]{64}$/);

    await page.getByTestId('profile-nav').click();
    await page.getByTestId('sign-out').waitFor();
    const profile = await page.getByTestId('profile-screen').innerText();
    assert.match(profile, /Анна Смирнова/);
    assert.match(profile, /Вход через мессенджер/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `profile has no horizontal overflow (got ${overflow}px)`);
    await settle(page);
    await page.getByTestId('profile-signin').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '77-profile-messenger-session.png') });

    // The session works for real API calls and ends on sign-out.
    const sessionCheck = await fetch(`${baseUrl}/api/session`, { headers: { authorization: `Bearer ${stored}` } });
    assert.equal(sessionCheck.status, 200);
    await Promise.all([page.waitForEvent('load'), page.getByTestId('sign-out').click()]);
    assert.equal(await page.evaluate(() => localStorage.getItem('detailflow.session')), null);
    await page.getByTestId('login-telegram').waitFor();
    assert.equal(await page.locator('.bottom-nav').count(), 0, 'after sign-out the app returns to the sign-in screen');
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { authorization: `Bearer ${stored}` } })).status, 401);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
