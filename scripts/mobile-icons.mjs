// Icons of the native app (mobile/assets/images), from the same car mark as the WebView shell and the site.
// Run: node scripts/mobile-icons.mjs
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath } from '../tests/e2e/chrome.mjs';

const out = resolve('mobile/assets/images');
const mark = (size, stroke) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${stroke}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15v-4l2-5h12l2 5v4"/><path d="M4 13h16M7 13v2m10-2v2M6 18h1m10 0h1"/></svg>`;
const tile = (size, share, stroke, ground) => `<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${ground}">${mark(Math.round(size * share), stroke)}</body>`;

// Adaptive icon layers are 108dp with a 66dp safe zone: the mark keeps the 60/108 share of the old icon.
const images = {
  'icon.png': [1024, tile(1024, 0.56, '#FF7939', '#0B1016')],
  'android-icon-foreground.png': [432, tile(432, 0.56, '#FF7939', 'transparent')],
  'android-icon-monochrome.png': [432, tile(432, 0.56, '#FFFFFF', 'transparent')],
  'splash-icon.png': [512, tile(512, 0.9, '#FF7939', 'transparent')],
  'favicon.png': [48, tile(48, 0.7, '#FF7939', '#0B1016')]
};

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
for (const [name, [size, html]] of Object.entries(images)) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(html);
  await page.screenshot({ path: resolve(out, name), omitBackground: true });
  console.log('saved', name);
}
await browser.close();
