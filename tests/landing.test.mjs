import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDetailFlowServer } from '../server/app.mjs';

let server;
let baseUrl;
let staticDir;

before(async () => {
  // A minimal build: the app shell plus the landing page copied from public/.
  staticDir = await mkdtemp(join(tmpdir(), 'detailflow-static-'));
  await mkdir(join(staticDir, 'landing', 'img'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<title>app</title>');
  await writeFile(join(staticDir, 'landing', 'index.html'), '<title>landing</title>');
  await writeFile(join(staticDir, 'landing', 'img', 'intake.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  await mkdir(join(staticDir, 'landing22'), { recursive: true });
  await writeFile(join(staticDir, 'landing22', 'index.html'), '<title>landing 2</title>');
  server = createDetailFlowServer({ databasePath: ':memory:', seed: true, staticDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(staticDir, { recursive: true, force: true });
});

test('the landing page is served at /landing/ next to the app', async () => {
  const redirect = await fetch(`${baseUrl}/landing`, { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), '/landing/');

  const page = await fetch(`${baseUrl}/landing/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(await page.text(), '<title>landing</title>');

  const image = await fetch(`${baseUrl}/landing/img/intake.jpg`);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');

  const second = await fetch(`${baseUrl}/landing22`, { redirect: 'manual' });
  assert.equal(second.status, 301, 'any folder with an index.html gets the trailing slash');
  assert.equal(second.headers.get('location'), '/landing22/');
  assert.equal((await fetch(`${baseUrl}/orders`, { redirect: 'manual' })).status, 200, 'app routes are not redirected');

  assert.equal(await (await fetch(`${baseUrl}/`)).text(), '<title>app</title>');
  assert.equal(await (await fetch(`${baseUrl}/orders/123`)).text(), '<title>app</title>', 'app routes still fall back to the app');
});
