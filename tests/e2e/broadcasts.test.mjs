import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { openDatabase } from '../../server/db.mjs';
import { chromePath } from './chrome.mjs';
import { acceptLegal } from './offline-helpers.mjs';

const ADMIN = `dfa_${'b'.repeat(64)}`;

test('the service owner sends a survey from /admin, an employee answers it in the feed, the result is in /admin', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'df-broadcast-e2e-'));
  const databasePath = join(folder, 'detailflow.db');
  const setup = openDatabase(databasePath, { seed: true });
  setup.prepare(`INSERT INTO platform_admins (provider, external_user_id) VALUES ('telegram', '5001')`).run();
  setup.prepare(`INSERT INTO admin_sessions (token_hash, provider, external_user_id, expires_at) VALUES (?, 'telegram', '5001', '2999-01-01 00:00:00')`)
    .run(createHash('sha256').update(ADMIN).digest('hex'));
  setup.close();
  const server = createDetailFlowServer({ databasePath, seed: false, staticDir: resolve('dist'), authTokens: new Map([
    ['master-token', { tenantId: 'tenant_demo', displayName: 'Дмитрий Соколов', roles: ['master'], memberId: 'member_demo_master' }]
  ]) });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await acceptLegal(baseUrl, 'master-token');
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    // The service owner writes a survey and sends it after checking who gets it.
    const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await adminContext.addInitScript((token) => localStorage.setItem('detailflow.admin', token), ADMIN);
    const admin = await adminContext.newPage();
    await admin.goto(`${baseUrl}/admin/`, { waitUntil: 'domcontentloaded' });
    await admin.getByTestId('tab-broadcasts').click();
    const form = admin.getByTestId('broadcast-form');
    await form.getByText('Опрос', { exact: true }).click();
    await form.locator('[name=title]').fill('Удобно ли записывать клиентов?');
    await form.locator('[name=body]').fill('Ответ займёт 10 секунд.');
    await form.locator('[name=options]').fill('Удобно\nНормально\nНеудобно');
    await form.locator('[name=rating]').check();
    await form.locator('[name=comment]').check();
    await admin.getByTestId('preview-broadcast').click();
    await admin.getByTestId('broadcast-preview').waitFor();
    assert.match(await admin.getByTestId('broadcast-preview').innerText(), /Опрос DetailFlow: Удобно ли записывать клиентов\?[\s\S]*Получат: 4/);
    await admin.screenshot({ path: resolve('artifacts', '100-admin-broadcast-preview.png'), fullPage: true });
    await admin.getByTestId('send-broadcast').click();
    await admin.getByTestId('broadcast-sent').waitFor();

    // The employee answers in the feed, once.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => localStorage.setItem('detailflow.session', 'master-token'));
    const page = await context.newPage();
    await page.goto(`${baseUrl}/?open=notifications`, { waitUntil: 'domcontentloaded' });
    const card = page.getByTestId('survey-answer');
    await card.waitFor();
    assert.equal(await page.getByTestId('send-survey').isDisabled(), true, 'nothing chosen yet');
    await card.getByText('Удобно', { exact: true }).click();
    await card.getByRole('button', { name: '5' }).click();
    await card.getByRole('textbox').fill('Быстро и понятно');
    await page.screenshot({ path: resolve('artifacts', '101-survey-in-feed.png'), fullPage: true });
    await page.getByTestId('send-survey').click();
    await page.getByTestId('survey-done').waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.goto(`${baseUrl}/?open=notifications`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('survey-done').waitFor();
    assert.equal(await page.getByTestId('survey-answer').count(), 0, 'answered once, the form is gone');

    // The result in /admin: the share, the rating, the comment with the center's name only.
    await admin.getByTestId('tab-broadcasts').click();
    await admin.getByTestId('broadcast-row').first().click();
    await admin.getByTestId('broadcast-results').waitFor();
    const results = await admin.getByTestId('broadcast-results').innerText();
    assert.match(results, /Ответили\s*1/);
    assert.match(results, /Средняя оценка\s*5/);
    assert.match(results, /Быстро и понятно[\s\S]*DetailFlow Studio/);
    assert.doesNotMatch(results, /Дмитрий|Соколов/, 'no person in the results');
    await admin.screenshot({ path: resolve('artifacts', '102-admin-survey-results.png'), fullPage: true });
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
    await rm(folder, { recursive: true, force: true });
  }
});
