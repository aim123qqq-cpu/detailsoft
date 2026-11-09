// Icons of the native app (mobile/assets/images) from the approved mark «Стекло» (8 Nov 2026):
// the car facing you, its windscreen filled orange. Run: node scripts/mobile-icons.mjs
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath } from '../tests/e2e/chrome.mjs';

const out = resolve('mobile/assets/images');
// Lines 46 of 480, round ends and joins; orange only on the glass.
const mark = (size, ink, glass) => `<svg width="${size}" height="${size}" viewBox="272 272 480 480"><path d="M370 400L340 480H684L654 400Z" fill="${glass}"/><path d="M322 582V488L366 368H658L702 488V582M322 536H702M393 536V582M632 536V582M370 655H393M632 655H655" fill="none" stroke="${ink}" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const tile = (size, inner, ground = 'transparent', radius = 0) => `<body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;background:${ground};border-radius:${radius}px;display:grid;place-items:center">${inner}</div></body>`;

const images = {
  // The home screen: the black plate (a light one gets lost on light wallpapers), the mark at 68 % of the side.
  'icon.png': [1024, tile(1024, mark(696, '#F4F4F2', '#FF8A4C'), '#121212')],
  // Adaptive layers (background #121212 in app.json): the launcher shows about two thirds, so the mark takes 45 %.
  'android-icon-foreground.png': [432, tile(432, mark(196, '#F4F4F2', '#FF8A4C'))],
  'android-icon-monochrome.png': [432, tile(432, mark(196, '#FFFFFF', '#FFFFFF'))],
  // The splash follows the phone's theme: a dark mark on the light ground, a light one on the dark.
  'splash-icon.png': [512, tile(512, mark(512, '#121212', '#EE6A22'))],
  'splash-icon-dark.png': [512, tile(512, mark(512, '#F4F4F2', '#FF8A4C'))],
  // The browser tab: the black plate rounded by 26 % of the side.
  'favicon.png': [48, tile(48, mark(33, '#F4F4F2', '#FF8A4C'), '#121212', 12.5)]
};

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
for (const [name, [size, html]] of Object.entries(images)) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(html);
  await page.screenshot({ path: resolve(out, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('saved', name);
}
await browser.close();
