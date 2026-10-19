// Builds the public copy of the landing (public/landing22) for GitHub Pages.
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
await writeFile(page, html.replace(marker, `<meta name="df-app" content="${appUrl.replace(/"/g, '&quot;')}">`));
// Plain static files: no Jekyll processing on GitHub Pages.
await writeFile(resolve(out, '.nojekyll'), '');
console.log(`landing → ${out}${appUrl ? ` (app: ${appUrl})` : ' (no app link)'}`);
