// Google Play listing images, drawn from the same car mark as the app icon:
// android/store/icon-512.png (512x512, Play masks the corners) and feature-1024x500.png.
// Run: node scripts/store-assets.mjs
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath } from '../tests/e2e/chrome.mjs';

const out = resolve('android/store');
await mkdir(out, { recursive: true });
const mark = (size, stroke = '#FF7939') => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${stroke}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15v-4l2-5h12l2 5v4"/><path d="M4 13h16M7 13v2m10-2v2M6 18h1m10 0h1"/></svg>`;
const fonts = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;700&family=Russo+One&display=swap">';

const pages = {
  // The mark fills the same share of the tile as in the 108dp adaptive icon (60 of 108).
  'icon-512.png': [512, 512, `<body style="margin:0;width:512px;height:512px;display:grid;place-items:center;background:#0B1016">${mark(284)}</body>`],
  'feature-1024x500.png': [1024, 500, `${fonts}<body style="margin:0;width:1024px;height:500px;display:grid;grid-template-columns:auto 1fr;align-items:center;gap:56px;padding:0 88px;box-sizing:border-box;background:#0B1016;color:#EEF1F3;font-family:Manrope,sans-serif">
    <div style="width:220px;height:220px;display:grid;place-items:center;border-radius:56px;background:#FF7939">${mark(150, '#1B110D')}</div>
    <div><div style="font-family:'Russo One',sans-serif;font-size:72px;line-height:1">DetailFlow</div>
    <div style="margin-top:20px;font-size:30px;font-weight:700;line-height:1.25">CRM детейлинг-центра<br>в одном телефоне</div>
    <div style="margin-top:16px;font-size:22px;color:#A9B4BD">Приёмка по схеме · смета · мастер · акты · без сети</div></div></body>`]
};

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
for (const [name, [width, height, html]] of Object.entries(pages)) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(out, name) });
  console.log('saved', name);
}
await browser.close();
