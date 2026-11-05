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

const ADMIN = `dfa_${'c'.repeat(64)}`;

test('the journal in /admin shows what happens in the bot as it happens, with an explanation', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'df-journal-e2e-'));
  const databasePath = join(folder, 'detailflow.db');
  const setup = openDatabase(databasePath, { seed: false });
  setup.prepare(`INSERT INTO platform_admins (provider, external_user_id) VALUES ('telegram', '995001')`).run();
  setup.prepare(`INSERT INTO admin_sessions (token_hash, provider, external_user_id, expires_at) VALUES (?, 'telegram', '995001', '2999-01-01 00:00:00')`)
    .run(createHash('sha256').update(ADMIN).digest('hex'));
  setup.close();
  const telegram = {
    provider: 'telegram', title: 'Telegram', botName: 'detailflow_test_bot', handler: null,
    deepLink(payload) { return `https://bots.example/detailflow_test_bot?start=${payload}`; },
    async start(handler) { this.handler = handler; }, stop() {}, async answerCallback() {}, async sendMessage() {}
  };
  const server = createDetailFlowServer({ databasePath, seed: false, staticDir: resolve('dist'), authTokens: new Map(), messengers: [telegram], backupDirectory: join(folder, 'backups') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript((token) => localStorage.setItem('detailflow.admin', token), ADMIN);
    const admin = await context.newPage();
    await admin.goto(`${baseUrl}/admin/`, { waitUntil: 'domcontentloaded' });
    await admin.getByTestId('tab-journal').click();
    await admin.getByTestId('journal-list').waitFor();

    // While the page is open, a newcomer writes /start to the bot by hand, then presses «Войти» on the sign-in screen.
    await telegram.handler({ provider: 'telegram', kind: 'start', userId: '700123', displayName: 'Никита', payload: '' });
    const login = await (await fetch(`${baseUrl}/api/auth/login-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'telegram' }) })).json();
    await telegram.handler({ provider: 'telegram', kind: 'start', userId: '700123', displayName: 'Никита', payload: new URL(login.deepLink).searchParams.get('start') });
    await telegram.handler({ provider: 'telegram', kind: 'start', userId: '700123', displayName: 'Никита', payload: `login_${'0'.repeat(32)}` });

    const list = admin.getByTestId('journal-list');
    await list.getByText('предложено создать центр').waitFor({ timeout: 5000 });
    const text = await list.innerText();
    assert.match(text, /написал \/start без ссылки входа — бот показал подсказку\s*Человек открыл бота сам/);
    assert.match(text, /Начат вход через Telegram/);
    assert.ok(text.indexOf('устаревшая ссылка') < text.indexOf('написал /start'), 'newest on top');
    assert.doesNotMatch(text, /Никита|700123/, 'no names or full ids');
    await admin.screenshot({ path: resolve('artifacts', '103-admin-journal.png'), fullPage: true });

    await admin.getByText('Только проблемы', { exact: true }).click();
    await admin.waitForFunction(() => document.querySelectorAll('[data-testid="journal-entry"]').length === 1);
    assert.match(await list.innerText(), /устаревшая ссылка/, 'only the stale link is a problem');

    // The overview: another period, the requests by kind, the centers.
    await admin.locator('[data-tab="overview"]').click();
    await admin.getByTestId('period-bar').waitFor();
    await admin.getByTestId('period-bar').getByText('7 дней', { exact: true }).click();
    await admin.waitForFunction(() => document.querySelector('[name="period"][value="7d"]')?.checked);
    const requests = admin.getByTestId('requests-card');
    await requests.getByText('Вход и регистрация').click();
    assert.match(await requests.innerText(), /Начало входа через мессенджер/);
    await admin.screenshot({ path: resolve('artifacts', '104-admin-overview.png'), fullPage: true });

    // Any dates, and the choice is still there after a reload.
    await admin.getByTestId('period-bar').getByText('Свои даты', { exact: true }).click();
    await admin.getByTestId('period-from').fill('2020-01-01');
    await admin.getByTestId('period-to').fill('2020-01-31');
    await admin.getByTestId('period-apply').click();
    await admin.waitForFunction(() => document.querySelector('[data-testid="period-from"]')?.value === '2020-01-01' && document.querySelector('[name="period"][value="custom"]')?.checked);
    await admin.reload({ waitUntil: 'domcontentloaded' });
    await admin.getByTestId('period-bar').waitFor();
    assert.equal(await admin.getByTestId('period-to').inputValue(), '2020-01-31');
    await admin.screenshot({ path: resolve('artifacts', '105-admin-past-period.png'), fullPage: true });

    // A broadcast with no title: the form lets it through.
    await admin.getByTestId('tab-broadcasts').click();
    const form = admin.getByTestId('broadcast-form');
    await form.locator('[name=body]').fill('Только текст, без заголовка');
    await admin.getByTestId('preview-broadcast').click();
    await admin.getByTestId('broadcast-preview').waitFor();
    assert.match(await admin.getByTestId('broadcast-preview').innerText(), /Новость DetailFlow\s+Только текст/);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
    await rm(folder, { recursive: true, force: true });
  }
});
