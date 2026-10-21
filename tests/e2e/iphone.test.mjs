import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium, devices } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';

const telegram = {
  provider: 'telegram', title: 'Telegram', botName: 'detailflow_bot',
  deepLink(payload) { return `https://t.me/detailflow_bot?start=${payload}`; },
  async start() {}, stop() {}, async sendMessage() {}, async answerCallback() {}
};

test('iPhone browser: how to add to the home screen, and fields that do not zoom the page', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist'), messengers: [telegram] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const { defaultBrowserType, ...iphone } = devices['iPhone 15'];
  const context = await browser.newContext(iphone);
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.getByTestId('login-telegram').waitFor();
    // iOS never offers to install a web app: the sign-in screen says how.
    assert.match(await page.getByTestId('ios-install').innerText(), /На экран „Домой“/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');

    await page.getByTestId('login-cancel').tap();
    await page.getByTestId('main-search').waitFor();
    // Safari zooms into a field with text under 16px and leaves the page zoomed.
    const small = await page.evaluate(() => [...document.querySelectorAll('input, textarea, select')]
      .filter((field) => parseFloat(getComputedStyle(field).fontSize) < 16).map((field) => field.outerHTML.slice(0, 80)));
    assert.deepEqual(small, []);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});

test('a regular desktop browser shows no iPhone hint', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist'), messengers: [telegram] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' });
    await page.getByTestId('login-telegram').waitFor();
    assert.equal(await page.getByTestId('ios-install').count(), 0);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
