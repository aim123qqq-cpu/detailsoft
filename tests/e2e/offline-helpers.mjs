/**
 * Waits until the app has saved answers whose paths end with the given suffixes in its offline
 * store. page.waitForFunction does not await an async predicate, so the page is polled with
 * page.evaluate; the database is never created from the test (that would race the app's schema).
 */
export async function waitForOfflineCopy(page, suffixes, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const keys = await page.evaluate(async () => {
      if (!(await indexedDB.databases()).some((db) => db.name === 'detailflow-offline')) return [];
      const db = await new Promise((done, fail) => {
        const request = indexedDB.open('detailflow-offline');
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
      try {
        if (!db.objectStoreNames.contains('cache')) return [];
        return await new Promise((done) => {
          const all = db.transaction('cache').objectStore('cache').getAllKeys();
          all.onsuccess = () => done(all.result.map(String));
        });
      } finally {
        db.close();
      }
    });
    if (suffixes.every((suffix) => keys.some((key) => key.endsWith(suffix)))) return;
    if (Date.now() > deadline) throw new Error(`offline copy not saved: ${suffixes.join(', ')} (have ${keys.join(', ')})`);
    await page.waitForTimeout(100);
  }
}

/** An employee in these tests has already accepted the agreement and the consent (the gate has its own tests). */
export async function acceptLegal(baseUrl, token) {
  const { LEGAL_VERSION } = await import('../../server/legal.mjs');
  const response = await fetch(`${baseUrl}/api/legal/accept`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ version: LEGAL_VERSION })
  });
  if (!response.ok) throw new Error(`accepting the documents failed: ${response.status}`);
}
