// Ready-to-upload folders for Google Play and Huawei AppGallery in artifacts/ (outside git):
//   artifacts/GooglePlay/  — the AAB, icon 512, banner 1024×500, 6 phone screenshots, texts, reviewer access
//   artifacts/AppGallery/  — the APK, icon 216, banner, the same screenshots and texts
// Build first: node scripts/build-mobile.mjs aab (Google Play) and node scripts/build-mobile.mjs apk (AppGallery).
// Run: node scripts/store-packages.mjs
// The texts come from docs/STORE.md (one source for every store); the reviewer's access code from
// ~/.detailflow/review-access.txt, so it never lands in git.
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath } from '../tests/e2e/chrome.mjs';

const app = JSON.parse(await readFile(resolve('mobile/app.json'), 'utf8')).expo;
const version = app.version;
const store = await readFile(resolve('docs/STORE.md'), 'utf8');
const between = (start, end) => {
  const from = store.indexOf(start);
  if (from < 0) throw new Error(`docs/STORE.md has no "${start}"`);
  const to = store.indexOf(end, from + start.length);
  return store.slice(from + start.length, to < 0 ? undefined : to).trim();
};
const short = between('**Короткое описание (до 80):**', '\n');
const full = between('**Полное описание:**', '**Категория:**');
if (short.length > 80) throw new Error(`The short description is ${short.length} characters, the stores allow 80`);
if (full.length > 4000) throw new Error(`The full description is ${full.length} characters, Google Play allows 4000`);

const whatsNew = 'Первая версия DetailFlow: запись клиентов, приёмка по схеме автомобиля с фото, смета и согласование, работа мастера, акты приёмки и выдачи с подписью клиента, работа без интернета, напоминания о записях.';
const listing = (iconName) => [
  `Название: DetailFlow`,
  `Краткое описание (${short.length} симв.): ${short}`,
  `Полное описание: файл 4-полное-описание.txt (${full.length} симв.)`,
  `Категория: Бизнес`,
  `Цена: бесплатно, без рекламы и покупок в приложении`,
  `Возраст: 3+ (Google Play — анкета IARC, «Все остальные типы приложений», всё «Нет»)`,
  `Иконка: ${iconName}`,
  `Email поддержки: detailfow@mail.ru`,
  `Сайт: https://detailflow.ru`,
  `Политика конфиденциальности: https://detailflow.ru/privacy/`,
  `Удаление аккаунта: https://detailflow.ru/privacy/#delete`,
  '',
  `Что нового (${version}):`,
  whatsNew
].join('\n');

// The reviewer's access code: the test center made by scripts/review-center.mjs on the server.
const accessFile = join(homedir(), '.detailflow', 'review-access.txt');
const code = existsSync(accessFile) ? (await readFile(accessFile, 'utf8')).match(/df_[0-9a-f]+/)?.[0] ?? null : null;
const access = [
  'Доступ для проверки (вставить в поле «Доступ к приложению» / «Тестовый аккаунт»):',
  '',
  'Имя пользователя: не требуется',
  `Код доступа (пароль): ${code ?? '<код из ~/.detailflow/review-access.txt — выпустите новый, см. docs/STORE.md>'}`,
  '',
  'Как войти:',
  '1. Приложение сразу открывает экран входа.',
  '2. Введите код в поле «Код доступа сотрудника» и нажмите «Войти по коду».',
  '3. Отметьте «Принимаю Пользовательское соглашение» и «Даю согласие на обработку персональных данных», нажмите «Продолжить».',
  '4. Откроется «Тестовый центр для проверки» с примерами услуг, клиентов, записей и заказом на приёмке. Изменения в нём ни на кого не влияют.',
  '',
  'Access for review (English):',
  'No username. On the sign-in screen enter the code above into "Код доступа сотрудника" (employee access code), tap "Войти по коду",',
  'tick both boxes (user agreement, consent to personal data processing) and tap "Продолжить". A demo detailing center with sample data opens.'
].join('\n');

// Phone screenshots 1080×1920 (9:16, no transparency, no Android status or gesture bars), from the store sources.
async function screenshots(browser, folder) {
  await mkdir(folder, { recursive: true });
  const source = resolve('mobile/store/screenshots');
  for (const name of (await readdir(source)).filter((file) => file.endsWith('.png')).sort()) {
    const data = (await readFile(join(source, name))).toString('base64');
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    // The source is 1080×2400: the status bar (top 110 px) and the gesture bar (bottom 90 px) go, the rest is
    // scaled to 1920 high and centered on the app's background.
    await page.setContent(`<body style="margin:0;width:1080px;height:1920px;overflow:hidden;background:#0B1016;display:grid;place-items:center">
      <div style="width:${Math.round(1080 * 1920 / 2200)}px;height:1920px;overflow:hidden">
        <img src="data:image/png;base64,${data}" style="display:block;width:100%;margin-top:${-Math.round(110 * 1920 / 2200)}px"></div></body>`);
    await page.screenshot({ path: join(folder, name.replace(/\.png$/, '.jpg')), type: 'jpeg', quality: 92 });
    await page.close();
  }
}

async function icon(browser, size, path) {
  const mark = `<svg viewBox="0 0 24 24" width="${Math.round(size * 0.56)}" height="${Math.round(size * 0.56)}" fill="none" stroke="#FF7939" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15v-4l2-5h12l2 5v4"/><path d="M4 13h16M7 13v2m10-2v2M6 18h1m10 0h1"/></svg>`;
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:#0B1016">${mark}</body>`);
  await page.screenshot({ path, type: 'png', omitBackground: false });
  await page.close();
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const stores = [
  { folder: 'GooglePlay', build: `DetailFlow-${version}.aab`, guide: 'GOOGLE_PLAY.md', icon: ['1-иконка-512.png', 512] },
  { folder: 'AppGallery', build: `DetailFlow-${version}.apk`, guide: 'APPGALLERY.md', icon: ['1-иконка-216.png', 216] }
];
for (const target of stores) {
  const out = resolve('artifacts', target.folder);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const build = resolve('artifacts', target.build);
  if (existsSync(build)) await copyFile(build, join(out, `0-${target.build}`));
  else console.warn(`! ${target.build} is not built yet: node scripts/build-mobile.mjs ${target.build.endsWith('.aab') ? 'aab' : 'apk'}`);
  if (target.icon[1] === 512) await copyFile(resolve('mobile/store/icon-512.png'), join(out, target.icon[0]));
  else await icon(browser, target.icon[1], join(out, target.icon[0]));
  await copyFile(resolve('mobile/store/feature-1024x500.png'), join(out, '2-обложка-1024x500.png'));
  await writeFile(join(out, '3-тексты-карточки.txt'), listing(target.icon[0]) + '\n');
  await writeFile(join(out, '4-полное-описание.txt'), full + '\n');
  await writeFile(join(out, '5-доступ-для-проверки.txt'), access + '\n');
  await screenshots(browser, join(out, '6-скриншоты-1080x1920'));
  await cp(resolve('docs', target.guide), join(out, 'ИНСТРУКЦИЯ.md'));
  console.log(`✓ artifacts/${target.folder}${code ? '' : ' (no reviewer code found)'}`);
}
await browser.close();
