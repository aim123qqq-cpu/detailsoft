import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';

// Scopes (the part of a cache key before "|") that have saved answers on this device.
const savedScopes = (page) => page.evaluate(() => new Promise((done) => {
  const open = indexedDB.open('detailflow-offline');
  open.onerror = () => done([]);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('cache')) { db.close(); return done([]); }
    const keys = db.transaction('cache').objectStore('cache').getAllKeys();
    keys.onsuccess = () => { db.close(); done([...new Set(keys.result.map((key) => String(key).split('|')[0]))]); };
  };
}));

test('mobile: an employee deletes the account from the profile and the device forgets it', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const owner = (path, init = {}) => fetch(`${baseUrl}${path}`, { ...init, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...init.headers } });
  const created = await (await owner('/api/tenants/current/team', { method: 'POST', body: JSON.stringify({ displayName: 'Мария Орлова', roles: ['intake'] }) })).json();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();

  try {
    // Signed in with the employee's access code.
    await page.addInitScript((token) => { if (!sessionStorage.getItem('signed')) { localStorage.setItem('detailflow.session', token); sessionStorage.setItem('signed', '1'); } }, created.accessToken);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('profile-nav').click();
    await page.getByTestId('profile-screen').getByText('Мария Орлова').waitFor();
    assert.equal(await page.getByTestId('privacy-link').getAttribute('href'), '/privacy/');

    await page.waitForTimeout(800);
    const employeeScopes = await savedScopes(page);
    assert.ok(employeeScopes.length > 0, 'the employee had data saved on the device');

    await page.getByTestId('delete-account').click();
    const dialog = page.getByRole('alertdialog');
    assert.match(await dialog.innerText(), /Заказы, акты и история работ останутся у центра/);
    await page.getByRole('button', { name: 'Отмена' }).click();
    assert.equal(await page.getByRole('alertdialog').count(), 0, 'cancel keeps the account');

    await page.getByTestId('delete-account').click();
    await page.getByTestId('confirm-delete-account').click();
    await page.waitForFunction(() => !localStorage.getItem('detailflow.session'));
    await page.waitForLoadState('domcontentloaded');

    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { authorization: `Bearer ${created.accessToken}` } })).status, 401);
    await page.waitForTimeout(800);
    const left = await savedScopes(page);
    assert.ok(employeeScopes.every((scope) => !left.includes(scope)), 'nothing the employee saved stays on the device');
    const team = await (await owner('/api/tenants/current/team')).json();
    assert.equal(team.items.find((member) => member.id === created.member.id).displayName, 'Удалённый сотрудник');

    const privacy = await page.goto(`${baseUrl}/privacy/`);
    assert.equal(privacy.status(), 200);
    assert.match(await page.locator('#delete').innerText(), /Как удалить аккаунт/);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
