// Builds public/licenses/index.html: the open-source components inside the web app and the Android app,
// with their license texts (MIT, BSD and Apache ask for their notices to travel with the program).
// Run after installing dependencies in the root and in mobile/:  node scripts/build-licenses.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The packages a project ships: its dependencies and theirs, without dev tools. */
function shipped(projectDir, roots) {
  const found = new Map();
  const visit = (name, fromDir) => {
    let manifestPath;
    try { manifestPath = createRequire(join(fromDir, 'noop.js')).resolve(`${name}/package.json`); }
    catch { manifestPath = findManifest(name, fromDir); }
    if (!manifestPath) return;
    const dir = dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const key = `${manifest.name}@${manifest.version}`;
    if (found.has(key)) return;
    found.set(key, { name: manifest.name, version: manifest.version, license: licenseOf(manifest), text: licenseText(dir), homepage: manifest.homepage ?? '' });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, dir);
  };
  for (const root of roots) visit(root, projectDir);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Packages without an exports entry for package.json: look for node_modules/<name> up the tree.
function findManifest(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

function licenseOf(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map((item) => item.type ?? item).join(' OR ');
  return 'см. текст';
}

function licenseText(dir) {
  const file = readdirSync(dir).find((entry) => /^(licen[cs]e|copying|notice)(\.|-|$)/i.test(entry));
  return file ? readFileSync(join(dir, file), 'utf8').trim() : '';
}

const root = resolve('.');
const web = shipped(root, ['react', 'react-dom']);
const mobileDir = resolve('mobile');
const mobileManifest = JSON.parse(readFileSync(join(mobileDir, 'package.json'), 'utf8'));
const android = shipped(mobileDir, Object.keys(mobileManifest.dependencies ?? {}));

const fonts = [
  { name: 'Manrope', license: 'OFL-1.1', text: readFileSync(resolve('public/fonts/LICENSE-Manrope.txt'), 'utf8').trim() },
  { name: 'Russo One', license: 'OFL-1.1', text: readFileSync(resolve('public/fonts/LICENSE-RussoOne.txt'), 'utf8').trim() }
];

const section = (title, items) => `
  <h2>${escape(title)} <small>(${items.length})</small></h2>
  ${items.map((item) => `<details><summary><b>${escape(item.name)}</b>${item.version ? ` ${escape(item.version)}` : ''} — ${escape(item.license)}</summary>${item.text ? `<pre>${escape(item.text)}</pre>` : '<p>Текст лицензии в пакете не приложен; условия — по указанной лицензии.</p>'}</details>`).join('\n  ')}`;

const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Лицензии открытых компонентов — DetailFlow</title>
  <style>
    :root { --ground: #f6f7f8; --ink: #16191c; --soft: #4c5257; --line: #d9dde0; --accent: #c4561f; color-scheme: light dark; }
    @media (prefers-color-scheme: dark) { :root { --ground: #0b1016; --ink: #e9edf0; --soft: #a9b4bd; --line: #26313a; --accent: #ff9a6d; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--ground); color: var(--ink); font: 16px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    main { width: min(100% - 32px, 860px); margin: 0 auto; padding: 48px 0 80px; }
    h1 { margin: 0 0 8px; font-size: clamp(26px, 5vw, 36px); }
    h2 { margin: 36px 0 10px; font-size: 21px; }
    h2 small, .meta { color: var(--soft); font-weight: 400; }
    details { border-bottom: 1px solid var(--line); padding: 8px 0; }
    summary { cursor: pointer; }
    pre { overflow-x: auto; white-space: pre-wrap; font-size: 12.5px; color: var(--soft); }
    a { color: var(--accent); }
  </style>
</head>
<body>
<main>
  <h1>Лицензии открытых компонентов</h1>
  <p class="meta">DetailFlow использует программы с открытым исходным кодом. Ниже — компоненты, которые входят в сайт и в приложение для Android, и тексты их лицензий. Список собран автоматически (scripts/build-licenses.mjs).</p>
  ${section('Шрифты', fonts)}
  ${section('Сайт detailflow.ru', web)}
  ${section('Приложение DetailFlow для Android', android)}
  <p class="meta"><a href="/terms/">Пользовательское соглашение</a> · <a href="/privacy/">Политика обработки персональных данных</a></p>
</main>
</body>
</html>
`;

await mkdir(resolve('public/licenses'), { recursive: true });
await writeFile(resolve('public/licenses/index.html'), html);
const unknown = [...web, ...android].filter((item) => !item.text).length;
console.log(`licenses: web ${web.length}, android ${android.length}, without a license file ${unknown} → public/licenses/index.html`);
