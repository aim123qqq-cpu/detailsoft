import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';
import { chromePath } from './chrome.mjs';
import { acceptLegal } from './offline-helpers.mjs';

async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
}

test('mobile: the owner builds a custom role from checkboxes and the employee gets exactly that access', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });

  try {
    const owner = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })).newPage();
    await owner.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await owner.getByTestId('profile-nav').click();
    await owner.getByTestId('team-entry').click();
    await owner.getByTestId('team-tab-roles').click();
    await owner.getByTestId('role-card-owner').waitFor();
    assert.match(await owner.getByTestId('role-card-owner').innerText(), /полный доступ/i);
    assert.equal(await owner.getByTestId('edit-role-owner').count(), 0, 'the owner role is not editable');
    await settle(owner);
    await owner.screenshot({ path: resolve(artifacts, '100-roles-list.png') });

    await owner.getByTestId('create-role').click();
    await owner.getByTestId('role-name').fill('Старший мастер');
    for (const permission of ['assignMasters', 'performWork', 'acceptAssignments']) await owner.getByTestId(`permission-${permission}`).click();
    assert.equal(await owner.getByTestId('permission-acceptAssignments').getAttribute('aria-pressed'), 'true');
    await settle(owner);
    await owner.screenshot({ path: resolve(artifacts, '101-role-editor.png') });
    await owner.getByTestId('save-role').click();
    const card = owner.locator('[data-testid^="role-card-role_"]');
    await card.waitFor();
    assert.match(await card.innerText(), /Старший мастер[\s\S]*Назначение мастера · Выполнение работ · Исполнитель заказов[\s\S]*Ни у кого нет/);

    await owner.getByTestId('team-tab-members').click();
    await owner.getByTestId('add-team-member').click();
    await owner.getByLabel('Имя сотрудника').fill('Олег Ким');
    await owner.getByTestId('member-role-intake').click();
    const customRole = owner.locator('[data-testid^="member-role-role_"]');
    assert.match(await customRole.innerText(), /Старший мастер[\s\S]*Назначение мастера, Выполнение работ, Исполнитель заказов/);
    await customRole.click();
    await owner.getByTestId('create-team-member').click();
    const accessToken = (await owner.getByTestId('team-access-token').locator('code').innerText()).trim();
    await owner.context().close();

    const employeeContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await acceptLegal(baseUrl, accessToken);
    await employeeContext.addInitScript((value) => localStorage.setItem('detailflow.session', value), accessToken);
    const employee = await employeeContext.newPage();
    await employee.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await employee.getByTestId('orders-workspace').waitFor();
    assert.match(await employee.locator('.workspace-filters button.selected').innerText(), /^Мои/, 'an executor starts on their own orders');
    await employee.getByTestId('bookings-nav').click();
    await employee.getByTestId('no-access').waitFor();
    await employee.getByTestId('profile-nav').click();
    await employee.getByTestId('profile-screen').getByText('Старший мастер').first().waitFor();
    assert.match(await employee.getByTestId('profile-screen').innerText(), /Олег Ким[\s\S]*Старший мастер/);
    await settle(employee);
    await employee.screenshot({ path: resolve(artifacts, '102-custom-role-profile.png') });
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
