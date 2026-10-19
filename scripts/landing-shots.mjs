// Screenshots of the app for the landing page (public/landing/img), taken from the demo data at 2x.
// Run after `pnpm build`: node scripts/landing-shots.mjs [output folder, public/landing/img by default]
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../server/app.mjs';
import { chromePath } from '../tests/e2e/chrome.mjs';

const out = resolve(process.argv[2] ?? 'public/landing/img');
await mkdir(out, { recursive: true });
const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await context.newPage();

async function shot(name, scrollTo) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  if (scrollTo) await page.locator(scrollTo).first().evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 70));
  await page.waitForTimeout(450);
  await page.screenshot({ path: resolve(out, `${name}.jpg`), type: 'jpeg', quality: 84 });
  console.log('saved', name);
}

try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('main-search').fill('+7 913 123-45-67');
  await page.getByTestId('customer-result').waitFor();
  await page.getByRole('button', { name: 'Добавить автомобиль' }).click();
  await page.getByTestId('add-vehicle-screen').waitFor();
  await page.getByRole('button', { name: /хэтчбек/ }).click();
  await page.getByTestId('plate-input').fill('К777КК 55');
  await page.getByTestId('color-input').fill('графитовый');
  await page.getByTestId('save-vehicle').click();
  await page.getByTestId('services-screen').waitFor();
  await page.getByTestId('offering-package_complex').locator('.offering-main').click();
  await page.getByTestId('offering-service_wash').locator('.offering-main').click();
  await page.getByText(/операции из пакета исключены/).waitFor();

  await page.getByTestId('choose-time').click();
  await page.getByTestId('schedule-screen').waitFor();
  await page.getByTestId('slot-16:00').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('schedule');

  await page.getByTestId('confirm-booking').click();
  await page.getByTestId('booking-confirmed').waitFor();
  await page.getByTestId('start-intake').click();
  await page.getByTestId('order-intake').waitFor();
  await page.getByTestId('body-type-hatchback').click();
  const finding = async (part, note, severity) => {
    await page.getByTestId(part).click();
    await page.getByTestId('finding-note').fill(note);
    await page.getByTestId('element-editor').getByRole('radio', { name: severity }).click();
    await page.getByTestId('add-finding').click();
  };
  await finding('car-part-right-front-fender', 'Скол ЛКП у кромки', 'Сильное');
  await finding('car-part-hood', 'Сколы от камней', 'Среднее');
  await finding('car-part-wheel-front-left', 'Бордюрная царапина', 'Лёгкое');
  await finding('car-part-left-rear-door', 'Мелкие царапины у ручки', 'Лёгкое');
  await shot('intake', '.body-type-picker');
  // The same intake on a tablet in landscape, as it hangs on the wall of a bay.
  await page.setViewportSize({ width: 1180, height: 820 });
  await shot('intake-tablet', '.inspection-tabs');
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByTestId('save-intake').click();
  await page.getByTestId('order-estimate').waitFor();
  await page.getByTestId('issue-intake_act').click();
  await page.getByTestId('document-signer').waitFor();
  await page.locator('.document-overlay').evaluate((element) => { element.scrollTop = 0; });
  await page.locator('.document-diagram').evaluate((element) => {
    const overlay = element.closest('.document-overlay');
    overlay.scrollTop = element.getBoundingClientRect().top - overlay.getBoundingClientRect().top - 150;
  });
  await shot('act');
  await page.keyboard.press('Escape');
  await page.locator('.document-overlay').waitFor({ state: 'hidden', timeout: 3000 }).catch(async () => {
    await page.locator('.document-overlay').getByRole('button', { name: /Закрыть|Назад|Отмена/ }).first().click();
  });

  await page.getByTestId('create-estimate').click();
  await page.getByTestId('order-approval').waitFor();
  await shot('approval');
  await page.getByTestId('approve-estimate').click();
  await page.getByTestId('order-approved').waitFor();
  await page.getByTestId('assign-master').click();
  await page.getByTestId('start-work').click();
  await page.getByTestId('master-work').waitFor();
  await page.getByTestId('work-operation-0').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="master-work"]')?.textContent?.includes('1 выполнено'));
  await shot('work');

  await page.getByTestId('profile-nav').click();
  await page.getByTestId('team-entry').click();
  await page.getByTestId('team-tab-roles').click();
  await page.getByTestId('role-card-owner').waitFor();
  await shot('roles');

} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
