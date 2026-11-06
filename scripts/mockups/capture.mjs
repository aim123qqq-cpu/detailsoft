// Mockups of the Android app for Figma: walks through the real screens with demo data and saves each one
// as an SVG of editable layers and a PNG. Run from the repository root: node scripts/mockups/capture.mjs
// (--no-build reuses the last browser build). The result goes to artifacts/figma-mockups (not in git).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { openDatabase } from '../../server/db.mjs';
import { LEGAL_VERSION } from '../../server/legal.mjs';
import { chromePath } from '../../tests/e2e/chrome.mjs';

const WIDTH = 412; // A typical Android phone: the emulator's Pixel 8 is 412×915 points.
const HEIGHT = 915;
const OUT = resolve('artifacts/figma-mockups');
const CACHE = join(tmpdir(), 'detailflow-mockups');
const WEB = join(CACHE, 'web');
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', ...options });
}

if (!process.argv.includes('--no-build') || !existsSync(WEB)) {
  console.log('· building the screens for the browser');
  run('npx', ['expo', 'export', '-p', 'web', '--output-dir', `"${WEB}"`], { cwd: resolve('mobile'), env: { ...process.env, DF_MOCKUPS: '1' } });
}

// Android's own fonts, so that lines break as on a phone; Figma has both.
function fonts() {
  const dir = join(CACHE, 'fonts');
  const faces = [];
  for (const [family, name, packageName, weights] of [
    ['Segoe UI', 'roboto', '@fontsource/roboto', [400, 500, 600, 700, 800, 900]],
    ['Roboto Mono', 'roboto-mono', '@fontsource/roboto-mono', [400, 700]]
  ]) {
    const folder = join(dir, name);
    if (!existsSync(join(folder, 'package'))) {
      mkdirSync(folder, { recursive: true });
      const file = run('npm', ['pack', packageName, '--silent'], { cwd: folder }).trim().split('\n').pop();
      run('tar', ['-xzf', file], { cwd: folder });
    }
    for (const weight of weights) for (const subset of ['latin', 'cyrillic']) {
      const data = readFileSync(join(folder, 'package/files', `${name}-${subset}-${weight}-normal.woff2`)).toString('base64');
      faces.push(`@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2");}`);
    }
  }
  return faces.join('');
}
const FONT_CSS = fonts();

// Material icons (Apache 2.0) of the five tabs: on a phone Android draws them itself.
const TAB_ICONS = {
  Статистика: 'M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z',
  Записи: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2zM7 12h5v5H7z',
  Новая: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z',
  Заказы: 'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z',
  Профиль: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 4c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm0 14c-2.03 0-4.43-.82-6.14-2.88C7.55 15.8 9.68 15 12 15s4.45.8 6.14 2.12C16.43 19.18 14.03 20 12 20z'
};

const telegram = {
  provider: 'telegram', title: 'Telegram', botName: 'detaliflow_bot', handler: null, lastStart: null,
  deepLink(payload) { this.lastStart = payload; return `about:blank#${payload}`; },
  async start(handler) { this.handler = handler; }, stop() {}, async sendMessage(_user, _text, buttons) { this.lastButtons = buttons; }, async answerCallback() {}
};
const max = { ...telegram, provider: 'max', title: 'MAX', botName: 'detailflow_max_bot', deepLink: (payload) => `about:blank#${payload}`, async start() {} };
const mailer = { letters: [], async send(letter) { this.letters.push(letter); } };
// A few more cars in the lists, each with its price class, as a center's own catalog has them.
const DATABASE = join(CACHE, 'demo.db');
for (const suffix of ['', '-wal', '-shm']) rmSync(DATABASE + suffix, { force: true });
mkdirSync(CACHE, { recursive: true });
const CARS = { kia: ['Kia', 'Rio', 'sedan', 'M', 'Средний'], skoda: ['Skoda', 'Octavia', 'sedan', 'M', 'Средний'], creta: ['Hyundai', 'Creta', 'suv', 'L', 'SUV'], lada: ['Lada', 'Vesta', 'sedan', 'M', 'Средний'], tiguan: ['Volkswagen', 'Tiguan', 'suv', 'L', 'SUV'] };
{
  const db = openDatabase(DATABASE, { seed: true });
  for (const [id, [make, model, body, system, tenantClass]] of Object.entries(CARS)) {
    db.prepare('INSERT INTO vehicle_catalog_variants (id, make, model, generation, year_from, year_to, body_type, system_vehicle_class) VALUES (?, ?, ?, NULL, 2015, 2026, ?, ?)').run(`variant_${id}`, make, model, body, system);
    db.prepare('INSERT INTO tenant_vehicle_class_rules (id, tenant_id, variant_id, class_match, tenant_class, priority) VALUES (?, ?, ?, NULL, ?, 100)').run(`rule_${id}`, 'tenant_demo', `variant_${id}`, tenantClass);
  }
  // Real sessions, so that the profile says how the person signed in.
  const session = db.prepare("INSERT INTO auth_sessions (id, tenant_id, member_id, token_hash, provider, expires_at) VALUES (?, 'tenant_demo', ?, ?, ?, '2999-01-01 00:00:00')");
  for (const [token, member, provider] of [['dfs_mock_owner', 'member_demo_owner', 'telegram'], ['dfs_mock_master', 'member_demo_master', 'max'], ['dfs_mock_employee', 'member_demo_intake', 'telegram']]) {
    session.run(`ses_${token}`, member, createHash('sha256').update(token).digest('hex'), provider);
  }
  db.close();
}
const server = createDetailFlowServer({
  databasePath: DATABASE, seed: false, staticDir: WEB, messengers: [telegram, max], mailer,
  authTokens: new Map([
    ['mock-empty', { tenantId: 'tenant_other', displayName: 'Новый владелец', roles: ['owner', 'admin'] }]
  ])
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const BASE = `http://127.0.0.1:${server.address().port}`;

let keyCount = 0;
async function call(path, method = 'GET', body, token = 'dfs_mock_owner') {
  const response = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `mock-${(keyCount += 1)}` }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });

// A picture standing in for a photo of the car, and a signature.
const helper = await browser.newPage();
const PHOTO = await helper.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
  const g = canvas.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 480); sky.addColorStop(0, '#39424d'); sky.addColorStop(1, '#1b2128');
  g.fillStyle = sky; g.fillRect(0, 0, 640, 480);
  g.fillStyle = '#7d8996'; g.beginPath(); g.moveTo(90, 320); g.lineTo(170, 220); g.lineTo(450, 220); g.lineTo(550, 320); g.closePath(); g.fill();
  g.fillRect(70, 310, 500, 60);
  g.fillStyle = '#12171c'; g.beginPath(); g.arc(180, 372, 42, 0, 7); g.arc(460, 372, 42, 0, 7); g.fill();
  return canvas.toDataURL('image/jpeg', 0.7);
});
const SIGNATURE = await helper.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 160;
  const g = canvas.getContext('2d'); g.strokeStyle = '#111'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(30, 110); g.bezierCurveTo(90, 10, 110, 150, 170, 70); g.bezierCurveTo(210, 20, 230, 140, 300, 80); g.bezierCurveTo(350, 50, 380, 120, 450, 60); g.stroke();
  return canvas.toDataURL('image/png');
});
await helper.close();

// Orders at every stage, on made-up people and cars.
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const orders = {};
async function seed() {
  for (const token of ['dfs_mock_owner', 'dfs_mock_master']) await call('/api/legal/accept', 'POST', { version: LEGAL_VERSION }, token);
  const person = async (name, phone, variant, plate, color) => {
    const customer = (await call('/api/customers', 'POST', { name, phone })).customer ?? await call('/api/customers?phone=' + phone.replace(/\D/g, '')).then((list) => list.items[0]);
    const { vehicle } = await call('/api/vehicles', 'POST', { customerId: customer.id, catalogVariantId: variant, plateDisplay: plate, color });
    return { customerId: customer.id, vehicleId: vehicle.id };
  };
  const booking = (who, date, hour, selections = [{ type: 'service', id: 'service_wash' }]) => call('/api/bookings', 'POST', { ...who, channel: 'in_person', startAt: `${date}T${hour}:00:00+03:00`, selections });
  const order = async (who, date, hour) => call('/api/orders', 'POST', { bookingId: (await booking(who, date, hour)).id });
  const intake = async (id) => {
    await call(`/api/orders/${id}/photos`, 'POST', { kind: 'intake', zone: 'Общий вид', dataUrl: PHOTO });
    await call(`/api/orders/${id}/photos`, 'POST', { kind: 'intake', zone: 'Капот', dataUrl: PHOTO });
    return call(`/api/orders/${id}/intake`, 'PUT', { conditionSummary: 'Автомобиль принят при клиенте', findings: [
      { zone: 'Капот', severity: 'HIGH', note: 'Скол ЛКП' }, { zone: 'Передний бампер', severity: 'MEDIUM', note: 'Царапина справа' }, { zone: 'Передние сиденья', severity: 'LOW', note: 'Пятно' }
    ], recommendations: [{ title: 'Защита кузова', reason: 'Снизит риск коррозии скола', priority: 'RECOMMENDED' }] });
  };
  const estimate = (id) => call(`/api/orders/${id}/estimates`, 'POST', { lines: [
    { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 },
    { sourceType: 'recommendation', name: 'Защита кузова', amountMinor: 90000, durationMinutes: 25 }
  ] });
  const approve = async (id) => call(`/api/orders/${id}/estimate-approvals`, 'POST', { estimateVersionId: (await estimate(id)).id, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна Смирнова' });
  const start = async (id) => {
    await call(`/api/orders/${id}/assignment`, 'PUT', { memberId: 'member_demo_master' });
    await call(`/api/orders/${id}/work/start`, 'POST', {});
  };
  const finish = async (id) => {
    for (const operation of (await call(`/api/orders/${id}`)).work.operations) await call(`/api/orders/${id}/work/operations/${operation.id}`, 'PATCH', { status: 'DONE', note: '' });
    await call(`/api/orders/${id}/work/complete`, 'POST', {});
  };
  // A service of the center's own: only those open for editing in the app.
  const section = await call('/api/tenants/current/catalog/sections', 'POST', { name: 'Химчистка' });
  await call('/api/tenants/current/catalog/simple-services', 'POST', { sectionId: section.id, name: 'Химчистка салона', description: 'Сиденья, потолок, ковры и багажник', pricingMode: 'fixed', basePrice: { amountMinor: 650000, durationMinutes: 180 }, classPrices: [] });
  const maria = await person('Мария Орлова', '+7 913 200-11-22', 'variant_kia', 'К215МН 55', 'белый');
  const sergey = await person('Сергей Кузнецов', '+7 913 200-33-44', 'variant_skoda', 'Т908ОР 55', 'серый');
  const olga = await person('Ольга Белова', '+7 913 200-55-66', 'variant_creta', 'Е340ХА 55', 'синий');
  const denis = await person('Денис Волков', '+7 913 200-77-88', 'variant_bmw_x5_g05', 'М777ВК 55', 'чёрный');
  const pavel = await person('Павел Никитин', '+7 913 200-99-00', 'variant_lada', 'О512СУ 55', 'красный');
  const irina = await person('Ирина Соловьёва', '+7 913 300-11-22', 'variant_tiguan', 'Н621АВ 55', 'серебристый');
  const alexey = { customerId: 'cust_alexey', vehicleId: 'veh_mazda' };
  const camry = { customerId: 'cust_alexey', vehicleId: 'veh_camry' };

  orders.intake = (await order(alexey, day(1), '09')).id;
  orders.draft = (await order(maria, day(1), '10')).id; await intake(orders.draft);
  orders.pending = (await order(sergey, day(1), '11')).id; await intake(orders.pending); await estimate(orders.pending);
  orders.approved = (await order(olga, day(1), '12')).id; await intake(orders.approved); await approve(orders.approved);
  orders.working = (await order(denis, day(1), '13')).id; await intake(orders.working); await approve(orders.working); await start(orders.working);
  orders.paused = (await order(irina, day(1), '14')).id; await intake(orders.paused); await approve(orders.paused); await start(orders.paused);
  await call(`/api/orders/${orders.paused}/work/pause`, 'POST', { note: 'Ждём сушки' });
  orders.ready = (await order(camry, day(1), '15')).id; await intake(orders.ready); await approve(orders.ready); await start(orders.ready); await finish(orders.ready);
  orders.closed = (await order(pavel, day(1), '16')).id; await intake(orders.closed); await approve(orders.closed); await start(orders.closed); await finish(orders.closed);
  const act = await call(`/api/orders/${orders.closed}/documents`, 'POST', { type: 'intake_act', signerName: 'Павел Никитин', signatureDataUrl: SIGNATURE });
  orders.act = (act.document ?? act).id;
  await call(`/api/orders/${orders.closed}/photos`, 'POST', { phase: 'result', kind: 'intake', zone: 'Результат', dataUrl: PHOTO });
  await call(`/api/orders/${orders.closed}/handover`, 'POST', { responsible: 'Анна Смирнова', note: 'Выдан без замечаний', customerAccepted: true, completenessChecked: true });
  {
    const db = openDatabase(DATABASE, { seed: false });
    const add = db.prepare("INSERT INTO notifications (id, tenant_id, member_id, kind, title, body, created_at, read_at) VALUES (?, 'tenant_demo', 'member_demo_owner', ?, ?, ?, datetime('now', ?), ?)");
    add.run('note_1', 'booking_reminder', 'Через час запись: 10:00', 'Мария Орлова · К215МН 55 · Kia Rio', '-10 minutes', null);
    add.run('note_2', 'day_plan', 'План на сегодня: 8 записей', 'Первая в 09:00, последняя в 16:00', '-3 hours', null);
    add.run('note_3', 'broadcast', 'Обновление DetailFlow: напоминания о записях', 'Теперь напоминания приходят в приложение и мессенджер.', '-1 days', new Date().toISOString().slice(0, 19).replace('T', ' '));
    db.close();
  }
  for (const [who, offset, hour] of [[maria, 2, '10'], [sergey, 2, '12'], [olga, 3, '11'], [denis, 3, '15'], [pavel, 4, '10']]) await booking(who, day(offset), hour);
}
await seed();

rmSync(OUT, { recursive: true, force: true });
for (const folder of ['svg', 'png']) mkdirSync(join(OUT, folder), { recursive: true });

const domToSvg = readFileSync(new URL('./dom-to-svg.js', import.meta.url), 'utf8');
async function newPage(token) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  await context.addInitScript(({ token, css }) => {
    // The app gives crypto its helpers on a phone, where the object is writable.
    Object.defineProperty(window, 'crypto', { value: window.crypto, writable: true, configurable: true });
    if (token) localStorage.setItem('detailflow.session', token);
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.append(style);
    });
  }, { token, css: FONT_CSS });
  await context.addInitScript(domToSvg);
  await context.route(/^about:blank/, (route) => route.abort());
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('   page error:', error.message.slice(0, 160)));
  return page;
}

/** The tab bar as Android draws it: on a phone it is the system's, in the browser build it is plain tabs on top. */
async function dressTabs(page) {
  await page.evaluate((icons) => {
    const bar = document.querySelector('[role="tablist"]');
    if (!bar) return;
    bar.parentElement.style.flexDirection = 'column-reverse';
    Object.assign(bar.style, { position: 'relative', top: 'auto', left: 'auto', right: 'auto', bottom: 'auto', transform: 'none', margin: '0', borderRadius: '0', boxShadow: 'none', backdropFilter: 'none', display: 'flex', flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', height: '80px', flex: '0 0 80px', padding: '0 4px', background: '#0b1016', borderTop: '0', overflow: 'visible', width: '100%', boxSizing: 'border-box' });
    for (const tab of bar.querySelectorAll('[role="tab"]')) {
      const label = tab.textContent.trim().replace(/\d+$/, '');
      const selected = tab.getAttribute('aria-selected') === 'true';
      Object.assign(tab.style, { flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', background: 'transparent', border: '0', borderRadius: '0', padding: '0', margin: '0', height: '80px', minWidth: '0', color: selected ? '#ff7939' : '#95a2af', fontSize: '12px', fontWeight: '500', overflow: 'visible' });
      if (tab.querySelector('[data-mock-icon]')) { tab.querySelector('[data-mock-icon]').style.background = selected ? 'rgba(255,121,57,.16)' : 'transparent'; tab.querySelector('path').setAttribute('fill', selected ? '#ff7939' : '#95a2af'); continue; }
      for (const child of tab.querySelectorAll('*')) { child.style.background = 'transparent'; child.style.color = 'inherit'; child.style.fontSize = '12px'; child.style.fontWeight = '500'; child.style.padding = '0'; }
      const pill = document.createElement('div');
      pill.dataset.mockIcon = '1';
      Object.assign(pill.style, { width: '64px', height: '32px', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: selected ? 'rgba(255,121,57,.16)' : 'transparent' });
      pill.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24"><path d="${icons[label] ?? ''}" fill="${selected ? '#ff7939' : '#95a2af'}"/></svg>`;
      tab.prepend(pill);
    }
    for (const el of document.querySelectorAll('[role="button"],a')) {
      const rect = el.getBoundingClientRect();
      if (rect.top < 64 && rect.right > window.innerWidth - 8 && rect.width && !el.dataset.mockMargin) { el.dataset.mockMargin = '1'; el.style.marginRight = '16px'; }
    }
    // The monospace of the sign-in code is Roboto Mono here too.
    for (const el of document.querySelectorAll('div,span,input')) if (/monospace/.test(getComputedStyle(el).fontFamily)) el.style.fontFamily = '"Roboto Mono", monospace';
  }, TAB_ICONS);
}

const shots = [];
const layerNames = new Map();
let current = '';
async function shot(page, name, { full = true } = {}) {
  const number = String(shots.length + 1).padStart(2, '0');
  const file = `${number} ${current} - ${name}`;
  await dressTabs(page);
  await page.waitForTimeout(250);
  // A long screen is drawn whole, as a designer wants it, with the tab bar in its place at the bottom.
  let height = HEIGHT;
  if (full) {
    const extra = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('div')].filter((el) => {
      const style = getComputedStyle(el);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.getClientRects().length && el.clientHeight > 100;
    }).map((el) => el.scrollHeight - el.clientHeight)));
    height = Math.min(HEIGHT + Math.ceil(extra), 5000);
    if (height !== HEIGHT) { await page.setViewportSize({ width: WIDTH, height }); await page.waitForTimeout(500); await dressTabs(page); }
  }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(OUT, 'png', `${file}.png`) });
  const layers = await page.evaluate(([w, h, prefix]) => window.__domToSvg(w, h, prefix), [WIDTH, height, `s${number}-`]);
  layers.body = layers.body.replace(/<g id="s\d+-([^"]*)"/g, (_all, name) => {
    const seen = (layerNames.get(name) ?? 0) + 1;
    layerNames.set(name, seen);
    return `<g id="${seen > 1 ? `${name} ${seen}` : name}"`;
  });
  writeFileSync(join(OUT, 'svg', `${file}.svg`), wrap(layers, WIDTH, height));
  shots.push({ file, group: current, name, height, layers });
  if (height !== HEIGHT) await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  console.log(`  ✓ ${file} (${WIDTH}×${height})`);
}

function wrap({ background, defs, body }, width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">${defs ? `<defs>${defs}</defs>` : ''}<rect width="${width}" height="${height}" ${background}/>${body}</svg>`;
}

const open = async (page, path, text) => {
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.getByText(text, { exact: typeof text === 'string' }).locator('visible=true').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
};
// Screens under the current one stay in the page: only what is visible counts.
const visible = (page, text, exact = true) => page.getByText(text, { exact }).locator('visible=true');
const tap = (page, text, exact = true) => visible(page, text, exact).first().click({ timeout: 10000 });
const see = (page, text, exact = true) => visible(page, text, exact).first().waitFor({ timeout: 15000 });
const failures = [];
async function group(name, walk) {
  current = name;
  if (only && !name.includes(only)) return;
  console.log(`· ${name}`);
  await walk();
}
async function scene(title, fn) {
  try { await fn(); } catch (error) { failures.push(`${current}: ${title}: ${error.message.split('\n')[0]}`); console.log(`  ✗ ${title}: ${error.message.split('\n')[0].slice(0, 140)}`); }
}

const owner = await newPage('dfs_mock_owner');
const signedOut = await newPage(null);

await group('Вход', async () => {
  await scene('вход', async () => {
    await open(signedOut, '/login', 'Войти в центр');
    await see(signedOut, /Продолжить с Telegram/, false);
    await shot(signedOut, 'Способы входа');
  });
  await scene('код', async () => { await tap(signedOut, 'Войти по коду доступа'); await see(signedOut, 'Войти по коду'); await shot(signedOut, 'Код доступа сотрудника'); });
  await scene('бот', async () => {
    await open(signedOut, '/login', 'Войти в центр');
    await tap(signedOut, /Продолжить с Telegram/, false);
    await signedOut.waitForTimeout(1500);
    await shot(signedOut, 'Подтверждение в боте');
  });
  await scene('почта', async () => {
    await open(signedOut, '/login', 'Войти в центр');
    await tap(signedOut, 'Войти по почте');
    await signedOut.getByPlaceholder('name@mail.ru').fill('anna@example.ru');
    await shot(signedOut, 'Вход по почте');
    await tap(signedOut, 'Получить код на почту');
    await see(signedOut, 'Код из письма');
    await signedOut.getByPlaceholder('000000').fill('482915');
    await shot(signedOut, 'Код из письма');
  });
  await scene('создать', async () => {
    await open(signedOut, '/login', 'Войти в центр');
    await tap(signedOut, 'Создать центр');
    await signedOut.waitForTimeout(500);
    await shot(signedOut, 'Новый центр - выбор способа');
    await tap(signedOut, /Продолжить с Telegram/, false);
    await signedOut.waitForTimeout(800);
    await telegram.handler({ provider: 'telegram', kind: 'start', userId: '880001', displayName: 'Анна', payload: telegram.lastStart });
    await telegram.handler({ provider: 'telegram', kind: 'callback', userId: '880001', payload: telegram.lastButtons[0][0].payload, callbackId: 'mock' });
    await see(signedOut, 'Создать центр');
    await signedOut.waitForTimeout(300);
    await shot(signedOut, 'Новый центр - название');
  });
  await scene('согласие', async () => {
    const page = await newPage('dfs_mock_employee');
    await open(page, '/orders', /соглашени/i);
    await shot(page, 'Согласие при первом входе');
    await page.context().close();
  });
  await scene('сервер', async () => { await open(signedOut, '/server', /сервер/i); await shot(signedOut, 'Адрес сервера (для тестов)'); });
});

await group('Заказы', async () => {
  const open_ = async (plate) => { await open(owner, '/orders', 'Все'); await tap(owner, plate); await owner.waitForTimeout(900); };
  await scene('список', async () => { await open(owner, '/orders', 'Все'); await see(owner, 'К215МН 55'); await shot(owner, 'Список заказов'); });
  await scene('в работе', async () => { await tap(owner, 'В работе'); await owner.waitForTimeout(600); await shot(owner, 'Отбор В работе'); });
  await scene('приёмка заказ', async () => { await open_('А123АА 55'); await shot(owner, 'Заказ - приёмка'); });
  await scene('приёмка', async () => {
    await tap(owner, 'Провести приёмку');
    await see(owner, 'Тип кузова');
    await shot(owner, 'Приёмка - схема автомобиля');
    await tap(owner, 'Кроссовер');
    await owner.waitForTimeout(500);
    const diagram = owner.getByLabel('Схема автомобиля, вид сверху').last();
    const box = await diagram.boundingBox();
    if (box) { await owner.mouse.click(box.x + box.width / 2, box.y + box.height * 0.22); await owner.waitForTimeout(600); }
    await shot(owner, 'Приёмка - элемент кузова');
  });
  await scene('смета черновик', async () => { await open_('К215МН 55'); await shot(owner, 'Заказ - смета не составлена'); });
  await scene('смета', async () => { await tap(owner, 'Составить смету'); await see(owner, 'Бережная мойка'); await shot(owner, 'Смета - составление'); });
  await scene('согласование', async () => { await open_('Т908ОР 55'); await shot(owner, 'Заказ - согласование сметы'); });
  await scene('назначение', async () => { await open_('Е340ХА 55'); await see(owner, 'Назначить мастера'); await shot(owner, 'Заказ - назначение мастера'); });
  await scene('работы', async () => { await open_('М777ВК 55'); await shot(owner, 'Заказ - работы мастера'); });
  await scene('пауза', async () => { await open_('Н621АВ 55'); await shot(owner, 'Заказ - работы на паузе'); });
  await scene('готов', async () => { await open_('В476РЕ 155'); await shot(owner, 'Заказ - готов к выдаче'); });
  await scene('выдача', async () => { await tap(owner, 'Выдать автомобиль'); await see(owner, /Снять результат/, false); await shot(owner, 'Выдача автомобиля'); });
  await scene('закрыт', async () => { await open_('О512СУ 55'); await shot(owner, 'Заказ - закрыт'); });
  await scene('акт', async () => { await open(owner, `/orders/document/${orders.closed}?type=intake_act&documentId=${orders.act}`, /Акт приёмки/); await shot(owner, 'Акт приёмки с подписью'); });
  await scene('подпись', async () => { await open(owner, `/orders/document/${orders.approved}?type=intake_act&signer=${encodeURIComponent('Ольга Белова')}`, /Акт приёмки/); await shot(owner, 'Акт - подпись клиента'); });
});

await group('Записи', async () => {
  await scene('список', async () => { await open(owner, '/bookings', 'Список'); await owner.waitForTimeout(800); await shot(owner, 'Список записей'); });
  await scene('дни', async () => { await tap(owner, 'По дням'); await owner.waitForTimeout(1000); await shot(owner, 'Записи по дням'); });
  await scene('карточка', async () => {
    await open(owner, '/bookings', 'Список');
    await owner.getByRole('button', { name: /Мария Орлова/ }).locator('visible=true').last().click();
    await owner.waitForTimeout(900);
    await shot(owner, 'Карточка записи');
    await tap(owner, 'Перенести');
    await owner.waitForTimeout(900);
    await shot(owner, 'Перенос записи');
  });
  await scene('клиент', async () => { await open(owner, '/customer/cust_alexey', 'Автомобили'); await shot(owner, 'Карточка клиента'); });
});

await group('Новая запись', async () => {
  await scene('старт', async () => { await open(owner, '/new', 'Новая запись'); await shot(owner, 'Поиск клиента'); });
  await scene('найден', async () => {
    await owner.getByPlaceholder('+7 999 000-00-00').fill('79131234567');
    await see(owner, 'Алексей Морозов');
    await owner.waitForTimeout(400);
    await shot(owner, 'Клиент найден');
  });
  await scene('услуги', async () => {
    await tap(owner, /В476РЕ 155/, false);
    await see(owner, 'Бережная мойка');
    await owner.waitForTimeout(500);
    await shot(owner, 'Выбор услуг');
    await tap(owner, 'Бережная мойка');
    await see(owner, /₽ · /, false);
    await shot(owner, 'Услуги - итог');
    await tap(owner, 'Выбрать время');
    await see(owner, '16:00');
    await owner.waitForTimeout(400);
    await tap(owner, '16:00');
    await shot(owner, 'Выбор времени');
    await tap(owner, 'Записать на 16:00');
    await see(owner, 'Запись подтверждена');
    await shot(owner, 'Запись подтверждена');
  });
  await scene('новый клиент', async () => {
    await open(owner, '/new', 'Новая запись');
    await owner.getByPlaceholder('+7 999 000-00-00').fill('79990001122');
    await see(owner, 'Клиент не найден');
    await owner.waitForTimeout(300);
    await shot(owner, 'Новый клиент');
    await owner.getByPlaceholder(/Например, Иван/).fill('Игорь Петров');
    await tap(owner, 'Создать клиента');
    const make = owner.getByRole('button', { name: 'Марка: выбрать' }).locator('visible=true').first();
    await make.waitFor({ timeout: 15000 });
    await shot(owner, 'Новый автомобиль');
    await make.click();
    await owner.waitForTimeout(600);
    await shot(owner, 'Выбор марки', { full: false });
  });
});

await group('Статистика', async () => {
  await scene('стат', async () => { await open(owner, '/analytics', '30 дней'); await owner.waitForTimeout(800); await shot(owner, 'Статистика центра'); });
});

await group('Профиль', async () => {
  await scene('профиль', async () => { await open(owner, '/profile', 'Каталог услуг'); await shot(owner, 'Профиль'); });
  await scene('уведомления', async () => { await open(owner, '/profile/notifications', /Уведомлен/); await see(owner, /План на сегодня/, false); await owner.waitForTimeout(400); await shot(owner, 'Уведомления'); });
  await scene('каталог', async () => {
    await open(owner, '/profile/catalog', 'Бережная мойка');
    await shot(owner, 'Каталог услуг');
    await tap(owner, '＋ Услуга');
    await owner.waitForTimeout(800);
    await shot(owner, 'Новая услуга');
  });
  await scene('услуга', async () => { await open(owner, '/profile/catalog', 'Химчистка салона'); await tap(owner, 'Химчистка салона'); await see(owner, 'Цена, ₽'); await shot(owner, 'Услуга - редактирование'); });
  await scene('график', async () => { await open(owner, '/profile/settings', /Сохранить график/); await shot(owner, 'График центра'); });
  await scene('команда', async () => { await open(owner, '/profile/team', '＋ Сотрудник'); await shot(owner, 'Команда'); await tap(owner, 'Роли и права'); await owner.waitForTimeout(600); await shot(owner, 'Роли и права'); });
  await scene('сотрудник', async () => { await open(owner, '/profile/member/member_demo_master', /Дмитрий Соколов/); await owner.waitForTimeout(500); await shot(owner, 'Карточка сотрудника'); });
  await scene('новый сотрудник', async () => { await open(owner, '/profile/member/new', 'Добавить сотрудника'); await shot(owner, 'Новый сотрудник'); });
  await scene('код сотрудника', async () => {
    await open(owner, '/profile/member/new', 'Добавить сотрудника');
    await owner.getByPlaceholder('Например, Мария Орлова').fill('Пётр Иванов');
    await tap(owner, 'Добавить сотрудника');
    await see(owner, 'Поделиться кодом');
    await shot(owner, 'Код доступа нового сотрудника');
  });
  await scene('роль', async () => { await open(owner, '/profile/role/new', 'Создать роль'); await shot(owner, 'Новая роль'); });
  await scene('роль мастера', async () => { await open(owner, '/profile/role/master', /Мастер/); await owner.waitForTimeout(400); await shot(owner, 'Права роли Мастер'); });
});

await group('Другие роли и состояния', async () => {
  await scene('мастер', async () => {
    const page = await newPage('dfs_mock_master');
    await open(page, '/orders', 'Все');
    await page.waitForTimeout(700);
    await shot(page, 'Мастер - заказы');
    await tap(page, 'М777ВК 55');
    await page.waitForTimeout(900);
    await shot(page, 'Мастер - работа над заказом');
    await open(page, '/analytics', /./);
    await page.waitForTimeout(600);
    await shot(page, 'Мастер - раздел недоступен');
    await page.context().close();
  });
  await scene('нет связи', async () => {
    const page = await newPage('dfs_mock_owner');
    await page.context().route('**/api/session', (route) => route.abort());
    await page.goto(BASE + '/orders', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await shot(page, 'Нет связи при запуске');
    await page.context().close();
  });
  await scene('пустой', async () => {
    const page = await newPage('mock-empty');
    await open(page, '/orders', 'Все');
    await page.waitForTimeout(600);
    await shot(page, 'Новый центр - первые шаги');
    await open(page, '/bookings', 'Список');
    await page.waitForTimeout(600);
    await shot(page, 'Новый центр - записей нет');
    await page.context().close();
  });
});

// The product's colours, spacing and the text styles really used on the screens, as a first frame.
function stylesFrame() {
  const theme = readFileSync(resolve('mobile/src/lib/theme.ts'), 'utf8');
  const colors = [...theme.matchAll(/^\s+(\w+): '(#[0-9a-f]{6})',?$/gim)].map((match) => [match[1], match[2]]);
  const text = (x, y, value, size = 14, weight = 400, fill = '#eef1f3') => `<text x="${x}" y="${y}" font-family="Roboto" font-size="${size}" font-weight="${weight}" fill="${fill}">${value}</text>`;
  const used = new Map();
  for (const { layers } of shots) for (const match of layers.body.matchAll(/font-family="Roboto" font-size="([\d.]+)" font-weight="(\d+)"/g)) {
    const key = `${match[1]}/${match[2]}`;
    used.set(key, (used.get(key) ?? 0) + 1);
  }
  const textStyles = [...used].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key]) => key.split('/').map(Number)).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let y = 56;
  let body = text(24, y, 'DetailFlow · стили', 28, 700);
  y += 44; body += text(24, y, 'Цвета', 13, 700, '#95a2af'); y += 14;
  for (const [name, value] of colors) {
    body += `<rect id="Цвет ${name}" x="24" y="${y}" width="56" height="40" rx="8" fill="${value}" stroke="#26313b"/>` + text(92, y + 18, name, 14, 600) + text(92, y + 35, value, 12, 400, '#95a2af');
    y += 52;
  }
  y += 20; body += text(24, y, 'Текст (Roboto): размер / жирность', 13, 700, '#95a2af'); y += 12;
  for (const [size, weight] of textStyles) { y += Math.max(30, size + 14); body += text(24, y, `${size} / ${weight} — Запись клиента`, size, weight); }
  y += 40; body += text(24, y, 'Отступы: 4 · 8 · 12 · 16 · 24 · 32', 14) + text(24, y + 24, 'Скругления: 8 · 12 · 16 · круглые (999)', 14);
  const height = y + 56;
  return { name: 'Стили', height, background: 'fill="#0b1016"', defs: '', body };
}
const styles = stylesFrame();
writeFileSync(join(OUT, 'svg', '00 Стили.svg'), wrap(styles, WIDTH, styles.height));

// Everything on one board: drop this one file into Figma and the screens lie in rows by section.
const GAP = 64; const ROW_GAP = 150;
let boardBody = ''; let boardDefs = '';
let y = 40; let boardWidth = 0;
const rows = new Map([['Стили', [{ ...styles }]]]);
for (const item of shots) rows.set(item.group, [...(rows.get(item.group) ?? []), { name: item.name, height: item.height, ...item.layers }]);
for (const [title, frames] of rows) {
  boardBody += `<text x="40" y="${y + 44}" font-family="Roboto" font-size="44" font-weight="700" fill="#eef1f3">${title}</text>`;
  y += 80;
  let x = 40; let tallest = 0;
  for (const frame of frames) {
    boardBody += `<text x="${x}" y="${y}" font-family="Roboto" font-size="15" fill="#95a2af">${frame.name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`;
    boardBody += `<g id="${title} - ${frame.name.replace(/"/g, '')}" transform="translate(${x} ${y + 12})"><rect width="${WIDTH}" height="${frame.height}" ${frame.background}/>${frame.body}</g>`;
    boardDefs += frame.defs;
    x += WIDTH + GAP;
    tallest = Math.max(tallest, frame.height);
  }
  boardWidth = Math.max(boardWidth, x);
  y += tallest + ROW_GAP;
}
const board = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${boardWidth}" height="${y}" viewBox="0 0 ${boardWidth} ${y}" fill="none">${boardDefs ? `<defs>${boardDefs}</defs>` : ''}<rect width="${boardWidth}" height="${y}" fill="#2a2f35"/>${boardBody}</svg>`;
writeFileSync(join(OUT, 'Все экраны.svg'), board);

// A check: each SVG drawn back with the same fonts must match the picture of the real screen.
const ROBOTO_CSS = FONT_CSS.replaceAll('font-family:"Segoe UI"', 'font-family:"Roboto"');
const check = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
const page = await check.newPage();
const differences = [];
for (const item of shots) {
  await page.setViewportSize({ width: WIDTH, height: item.height });
  await page.setContent(`<!doctype html><style>${ROBOTO_CSS}body{margin:0}svg{display:block}</style>${readFileSync(join(OUT, 'svg', `${item.file}.svg`), 'utf8')}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const drawn = (await page.screenshot()).toString('base64');
  const real = readFileSync(join(OUT, 'png', `${item.file}.png`)).toString('base64');
  const share = await page.evaluate(async ([a, b]) => {
    const load = (data) => new Promise((done) => { const image = new Image(); image.onload = () => done(image); image.src = `data:image/png;base64,${data}`; });
    const [one, two] = await Promise.all([load(a), load(b)]);
    const pixels = (image) => { const canvas = document.createElement('canvas'); canvas.width = one.width; canvas.height = one.height; const g = canvas.getContext('2d', { willReadFrequently: true }); g.drawImage(image, 0, 0); return g.getImageData(0, 0, one.width, one.height).data; };
    const x = pixels(one), y = pixels(two);
    let different = 0;
    for (let i = 0; i < x.length; i += 4) if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 90) different += 1;
    return different / (x.length / 4);
  }, [drawn, real]);
  differences.push([share, item.file]);
}
// A sheet of everything, to look through at once.
const sheet = await check.newPage();
await sheet.setViewportSize({ width: Math.floor(Math.min(boardWidth, 8000, boardWidth * 15000 / y)), height: 1000 });
await sheet.setContent(`<!doctype html><style>${ROBOTO_CSS}body{margin:0}svg{display:block;width:100%;height:auto}</style>${board}`);
await sheet.evaluate(() => document.fonts.ready);
await sheet.waitForTimeout(500);
await sheet.screenshot({ path: join(OUT, 'Обзор всех экранов.png'), fullPage: true, scale: 'css' });
await check.close();

writeFileSync(join(OUT, 'КАК ПОЛОЖИТЬ В FIGMA.txt'), `DetailFlow: макеты приложения для Android, ${shots.length} экранов и страница стилей.
Сняты с настоящего кода приложения ${new Date().toLocaleDateString('ru-RU')}, данные вымышленные.

КАК ПОЛОЖИТЬ В FIGMA
Вариант 1, всё сразу: перетащите файл «Все экраны.svg» на холст Figma. Экраны лягут рядами по разделам.
Вариант 2, по одному: откройте папку svg и перетащите нужные файлы (можно все сразу).
Шрифт Roboto в Figma уже есть, ничего устанавливать не нужно.

ЧТО ВНУТРИ
Все экраны.svg            все макеты одной доской, редактируемые слои
svg\\                      каждый экран отдельным файлом, редактируемые слои: текст, фигуры, иконки
png\\                      те же экраны картинками, вдвое крупнее (для сверки и презентаций)
Обзор всех экранов.png    всё на одной картинке

ЧТО УЧЕСТЬ
- Размер кадра 412 точек в ширину, как у Pixel 8. Длинные экраны показаны целиком, их высота больше 915.
- Системной строки Android сверху нет, рисуйте её при необходимости.
- Текст: каждая строка абзаца отдельным слоем. Автолейаута и компонентов нет, их Figma из SVG не создаёт.
- Системные окна Android (подтверждения, камера, выбор файла) не сняты: их рисует сам телефон.
- Сейчас у приложения только тёмная тема.

КАК ОБНОВИТЬ
В папке проекта: node scripts/mockups/capture.mjs
`);

await browser.close();
await new Promise((done) => server.close(done));

differences.sort((a, b) => b[0] - a[0]);
console.log(`\n${shots.length} screens, ${failures.length} not taken; board ${(statSync(join(OUT, 'Все экраны.svg')).size / 1e6).toFixed(1)} MB`);
console.log('SVG vs screen, most different:');
for (const [share, file] of differences.slice(0, 8)) console.log(`  ${(share * 100).toFixed(2)}%  ${file}`);
for (const failure of failures) console.log('  ✗', failure);
