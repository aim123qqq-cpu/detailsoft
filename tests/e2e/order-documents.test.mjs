import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createDetailFlowServer } from '../../server/app.mjs';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const photoDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);
}

test('mobile intake and handover acts: preview, finger signature, numbering, print view and outdated state', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir: resolve('dist') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let keyCounter = 0;
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.ok(response.ok, `${method} ${path} → ${response.status}`);
    return response.json();
  };
  const saveIntake = (orderId, note) => call(`/api/orders/${orderId}/intake`, 'PUT', {
    conditionSummary: 'Автомобиль принят при клиенте, комплектность проверена',
    findings: [{ zone: 'Переднее крыло', severity: 'MEDIUM', note }],
    recommendations: [{ title: 'Локальная защита скола', reason: 'Снизит риск коррозии', priority: 'RECOMMENDED' }]
  });
  const startOrder = async (startAt) => {
    const booking = await call('/api/bookings', 'POST', {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'in_person', startAt, selections: [{ type: 'service', id: 'service_wash' }]
    }, { 'idempotency-key': `e2e-documents-${keyCounter += 1}` });
    const order = await call('/api/orders', 'POST', { bookingId: booking.id });
    await call(`/api/orders/${order.id}/photos`, 'POST', { phase: 'intake', kind: 'intake', zone: 'Кузов', dataUrl: photoDataUrl });
    await saveIntake(order.id, 'Скол ЛКП на переднем крыле');
    return order.id;
  };

  const intakeOrderId = await startOrder('2026-12-29T10:00:00+03:00');
  const closedOrderId = await startOrder('2026-12-29T14:00:00+03:00');
  const estimate = await call(`/api/orders/${closedOrderId}/estimates`, 'POST', { lines: [
    { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 }
  ] });
  await call(`/api/orders/${closedOrderId}/estimate-approvals`, 'POST', {
    estimateVersionId: estimate.id, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна'
  });
  await call(`/api/orders/${closedOrderId}/assignment`, 'PUT', { masterName: 'Дмитрий Соколов' });
  const started = await call(`/api/orders/${closedOrderId}/work/start`, 'POST', {});
  for (const operation of started.work.operations) {
    await call(`/api/orders/${closedOrderId}/work/operations/${operation.id}`, 'PATCH', { status: 'DONE', note: '' });
  }
  await call(`/api/orders/${closedOrderId}/work/complete`, 'POST', {});
  await call(`/api/orders/${closedOrderId}/photos`, 'POST', { phase: 'result', kind: 'intake', zone: 'Результат работ', dataUrl: photoDataUrl });
  await call(`/api/orders/${closedOrderId}/handover`, 'POST', {
    responsible: 'Анна', note: 'Клиент принял автомобиль', customerAccepted: true, completenessChecked: true
  });

  const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  // Stand-in for the phone's system share sheet: records what the app hands over.
  await context.addInitScript(() => {
    window.__shared = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => { window.__shared.push(data); } });
  });
  const page = await context.newPage();
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('orders-nav').click();
    await page.getByTestId(`order-card-${intakeOrderId}`).click();
    await page.getByTestId('documents-panel').waitFor();
    assert.match(await page.getByTestId('document-row-intake_act').innerText(), /Ещё не оформлен/);
    assert.equal(await page.getByTestId('document-row-handover_act').count(), 0, 'handover act is offered only after closing');
    assert.equal(await page.getByTestId('share-order-button').count(), 0, 'sharing is offered only after handover');
    await settle(page);
    await page.getByTestId('documents-panel').evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(artifacts, '67-order-documents-panel.png') });

    // Preview before signing: the client sees the exact content of the act.
    await page.getByTestId('issue-intake_act').click();
    await page.getByTestId('document-signer').waitFor();
    const preview = await page.getByTestId('document-paper').innerText();
    assert.match(preview, /Акт приёмки автомобиля/);
    assert.match(preview, /Предпросмотр/);
    assert.match(preview, /Скол ЛКП на переднем крыле/);
    assert.match(preview, /А123АА 55/);
    const overlay = await page.locator('.document-overlay').boundingBox();
    assert.ok(overlay && overlay.width === 390 && overlay.height === 844, 'document overlay covers the whole viewport');
    const overflow = await page.evaluate(() => document.querySelector('.document-overlay').scrollWidth - document.querySelector('.document-overlay').clientWidth);
    assert.ok(overflow <= 0, `document has no horizontal overflow (got ${overflow}px)`);
    await page.screenshot({ path: resolve(artifacts, '68-document-preview.png') });

    assert.equal(await page.getByTestId('sign-document').isDisabled(), true, 'signing needs a drawn signature');
    const pad = page.getByTestId('signature-pad');
    await pad.scrollIntoViewIfNeeded();
    const box = await pad.boundingBox();
    await page.mouse.move(box.x + 30, box.y + 110);
    await page.mouse.down();
    for (const [dx, dy] of [[60, -50], [100, 20], [150, -40], [210, 30], [260, -20], [300, 10]]) {
      await page.mouse.move(box.x + dx, box.y + 90 + dy, { steps: 6 });
    }
    await page.mouse.up();
    assert.equal(await page.getByTestId('sign-document').isDisabled(), false);
    await settle(page);
    await page.screenshot({ path: resolve(artifacts, '69-document-signature.png') });

    await page.getByTestId('sign-document').click();
    await page.getByTestId('document-viewer').waitFor();
    const signed = await page.getByTestId('document-paper').innerText();
    assert.match(signed, /№ АП-000001/);
    assert.match(signed, /Алексей Морозов/);
    assert.equal(await page.locator('.document-paper img').count(), 1, 'signature image is embedded in the act');
    await settle(page);
    await page.locator('.document-signatures').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(artifacts, '70-document-signed.png') });

    await page.emulateMedia({ media: 'print' });
    await page.screenshot({ path: resolve(artifacts, '71-document-print.png'), fullPage: true });
    const hiddenNav = await page.evaluate(() => getComputedStyle(document.querySelector('.bottom-nav')).visibility);
    assert.equal(hiddenNav, 'hidden', 'print output contains only the document');
    await page.emulateMedia({ media: 'screen' });

    await page.getByTestId('close-document').click();
    await page.getByText(/№ АП-000001 · подписан: Алексей Морозов/).waitFor();

    // A repeated inspection keeps the signed act but marks it outdated.
    await page.waitForTimeout(1100);
    await saveIntake(intakeOrderId, 'Скол ЛКП и царапина на двери');
    await page.locator('.details-back:visible').click();
    await page.getByTestId(`order-card-${intakeOrderId}`).click();
    await page.getByText(/устарел после повторного осмотра/).waitFor();
    await page.getByTestId('open-intake_act').click();
    await page.getByText('Акт устарел').waitFor();
    assert.match(await page.getByTestId('document-paper').innerText(), /Скол ЛКП на переднем крыле/);
    await page.getByTestId('close-document').click();

    // Handover act for a closed order, issued without a signature for paper signing.
    await page.locator('.details-back:visible').click();
    await page.getByTestId(`order-card-${closedOrderId}`).click();
    await page.getByTestId('document-row-handover_act').waitFor();

    // After handover the order can be shared through the system share sheet.
    assert.equal(await page.getByTestId('share-order-button').count(), 1);
    await page.getByTestId('share-order-button').click();
    await page.waitForFunction(() => window.__shared.length === 1);
    const shared = await page.evaluate(() => window.__shared[0]);
    assert.equal(shared.title, 'Заказ-наряд');
    assert.match(shared.text, /^DetailFlow Studio — заказ-наряд\nMazda 3 BL, А123АА 55\nВыдан: /);
    assert.match(shared.text, /• Бережная мойка — 1\s400\s₽/);
    assert.match(shared.text, /Итого по согласованной смете v1: 1\s400\s₽/);
    assert.doesNotMatch(shared.text, /\+7|оплат/i);
    await settle(page);
    await page.getByTestId('share-order').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '80-share-order.png') });

    // Without HTTPS (no share sheet, no clipboard) the text is shown for manual copying.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    });
    await page.getByTestId('share-order-button').click();
    await page.getByTestId('share-order-manual').waitFor();
    assert.match(await page.getByTestId('share-order-text').inputValue(), /Итого по согласованной смете v1/);
    await settle(page);
    await page.getByTestId('share-order-manual').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifacts, '81-share-order-manual.png') });
    await page.getByTestId('issue-handover_act').click();
    await page.getByTestId('document-signer').waitFor();
    await page.getByTestId('issue-unsigned').click();
    await page.getByTestId('document-viewer').waitFor();
    const handover = await page.getByTestId('document-paper').innerText();
    assert.match(handover, /№ АВ-000001/);
    assert.match(handover, /Бережная мойка/);
    assert.match(handover, /согласованной смете v1/);
    assert.doesNotMatch(handover, /оплачено|оплата/i);
    await settle(page);
    await page.locator('.document-table').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(artifacts, '72-handover-act.png') });
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
