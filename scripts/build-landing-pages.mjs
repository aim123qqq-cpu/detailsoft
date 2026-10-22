// Builds the public copy of the landing (public/landing22) and the privacy policy for GitHub Pages.
// APP_URL is where the app lives (empty: the buttons stay on the page's own demo).
//   APP_URL=https://app.example.ru node scripts/build-landing-pages.mjs [output folder, site/ by default]
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'site');
const appUrl = process.env.APP_URL ?? '';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(resolve('public/landing22'), out, { recursive: true });
const page = resolve(out, 'index.html');
const html = await readFile(page, 'utf8');
const marker = '<meta name="df-app" content="/">';
if (!html.includes(marker)) throw new Error('The landing has no df-app meta tag');
// The privacy policy travels with the copy; on Pages the site sits in a subfolder, so its link is relative.
await cp(resolve('public/privacy'), resolve(out, 'privacy'), { recursive: true });
await cp(resolve('public/fonts'), resolve(out, 'fonts'), { recursive: true });
await writeFile(page, html
  .replace(marker, `<meta name="df-app" content="${appUrl.replace(/"/g, '&quot;')}">`)
  .replace('href="/privacy/" data-privacy-link', 'href="privacy/" data-privacy-link')
  .replace('href="/fonts/fonts.css"', 'href="fonts/fonts.css"'));
// Plain static files: no Jekyll processing on GitHub Pages.
await writeFile(resolve(out, '.nojekyll'), '');
console.log(`landing → ${out}${appUrl ? ` (app: ${appUrl})` : ' (no app link)'}`);
