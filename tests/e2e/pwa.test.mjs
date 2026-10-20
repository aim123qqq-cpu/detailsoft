import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';

test('browser app: installable, and it opens again with the network off', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  try {
    const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
    const { icons, start_url: startUrl, display } = await manifest.json();
    assert.equal(startUrl, '/');
    assert.equal(display, 'standalone');
    for (const icon of icons) assert.equal((await fetch(`${baseUrl}${icon.src}`)).headers.get('content-type'), 'image/png', icon.src);
    assert.ok(icons.some((icon) => icon.purpose === 'maskable'));

    // 127.0.0.1 is a secure context, so the worker installs as it would over HTTPS.
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.getByTestId('main-search').waitFor();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(async () => {
      const cache = await caches.open('detailflow-shell-v1');
      const keys = (await cache.keys()).map((request) => new URL(request.url).pathname);
      return keys.includes('/index.html') && keys.some((path) => path.startsWith('/assets/') && path.endsWith('.js'));
    });

    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.getByTestId('main-search').waitFor({ timeout: 10_000 });
    await page.getByTestId('offline-banner').waitFor();

    // Static pages beside the app are not taken over by the worker.
    await context.setOffline(false);
    const landing = await page.goto(`${baseUrl}/landing/`, { waitUntil: 'load' });
    assert.equal(landing.status(), 200);
    assert.equal(await page.locator('[data-testid="main-search"]').count(), 0);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
