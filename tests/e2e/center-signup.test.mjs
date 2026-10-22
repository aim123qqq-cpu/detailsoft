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

test('a production server: a person creates a center in the browser and lands in it as the owner', async () => {
  const telegram = fakeAdapter('telegram', 'Telegram', 'detailflow_bot');
  // No demo center and no demo access, as on the real server.
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: false, authTokens: new Map(), staticDir: resolve('dist'), messengers: [telegram] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('toggle-signup').click();
    await page.getByRole('heading', { name: 'Создайте свой центр' }).waitFor();
    await page.screenshot({ path: resolve(artifacts, '95-signup-start.png'), fullPage: true });
    await page.getByTestId('login-telegram').click();
    const startPayload = new URL(await page.getByTestId('open-bot').getAttribute('href')).searchParams.get('start');

    await telegram.handler({ provider: 'telegram', kind: 'start', userId: '501', displayName: 'Никита', payload: startPayload });
    const prompt = telegram.sent.at(-1);
    assert.match(prompt.text, /Создание центра/);
    await telegram.handler({ provider: 'telegram', kind: 'callback', userId: '501', payload: prompt.buttons[0][0].payload, callbackId: 'cb' });

    await page.getByTestId('login-signup').waitFor();
    await page.getByTestId('center-name').fill('Детейлинг Север');
    await page.getByTestId('owner-name').fill('Никита Шиганов');
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `no horizontal overflow at ${width}px (got ${overflow}px)`);
    }
    await page.screenshot({ path: resolve(artifacts, '96-signup-center-name.png'), fullPage: true });
    await page.getByTestId('create-center').click();

    // The workplace opens in the new center, with the owner's sections.
    await page.locator('.bottom-nav').waitFor();
    // An empty center: the owner is told what to do first, and each step opens its section.
    await page.getByTestId('first-steps').waitFor();
    assert.match(await page.locator('.context-line').innerText(), /Детейлинг Север/, 'the center is named, not the demo one');
    await page.screenshot({ path: resolve(artifacts, '96b-first-steps.png'), fullPage: true });
    await page.getByTestId('first-step-team').click();
    await page.getByTestId('team-screen').waitFor();
    await page.getByTestId('new-booking-nav').click();
    await page.getByTestId('first-step-booking').click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'search-input', 'the booking step puts the cursor in the phone search');
    await page.getByTestId('profile-nav').click();
    await page.getByText('Детейлинг Север').first().waitFor();
    await page.getByText('Никита Шиганов').first().waitFor();
    await page.getByTestId('team-entry').waitFor();
    await page.screenshot({ path: resolve(artifacts, '97-signup-owner-profile.png'), fullPage: true });
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
