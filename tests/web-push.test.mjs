import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, createVerify, hkdfSync, randomBytes } from 'node:crypto';
import { encryptForSubscription, generateVapidKeys, vapidAuthorization } from '../server/web-push.mjs';
import { openDatabase } from '../server/db.mjs';
import { DetailFlowRepository } from '../server/repository.mjs';
import { createNotificationCenter } from '../server/notifications.mjs';
import { createDetailFlowServer } from '../server/app.mjs';

/** A browser's side: its keys, and decrypting what the server sent (RFC 8291). */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    decrypt(body) {
      const salt = body.subarray(0, 16);
      const idLength = body[20];
      const senderKey = body.subarray(21, 21 + idLength);
      const shared = ecdh.computeSecret(senderKey);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), senderKey]);
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
      const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const record = body.subarray(21 + idLength);
      const decipher = createDecipheriv('aes-128-gcm', key, nonce);
      decipher.setAuthTag(record.subarray(record.length - 16));
      const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
      assert.equal(plain.at(-1), 2, 'the last record ends with the 0x02 delimiter');
      return plain.subarray(0, -1).toString('utf8');
    }
  };
}

test('a message encrypted for a browser decrypts only there, and the VAPID signature checks out', () => {
  const phone = browser();
  const message = JSON.stringify({ title: 'Через 1 час запись', body: '12:00 · Toyota Camry · 1 ч 30 мин' });
  assert.equal(phone.decrypt(encryptForSubscription(message, phone.keys)), message);
  assert.throws(() => browser().decrypt(encryptForSubscription(message, phone.keys)), 'another browser cannot read it');

  const vapid = generateVapidKeys();
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, 'https://detailflow.ru', Date.parse('2026-11-02T10:00:00Z'));
  const [, jwt, key] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(key, vapid.publicKey);
  const [head, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: Date.parse('2026-11-02T10:00:00Z') / 1000 + 12 * 3600, sub: 'https://detailflow.ru' });
  const point = Buffer.from(vapid.publicKey, 'base64url');
  const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
  assert.ok(createVerify('SHA256').update(`${head}.${claims}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});

test('a notification goes to every device of the member; a device the push service forgot is removed', async () => {
  const db = openDatabase(':memory:', { seed: true });
  const sent = [];
  const answers = new Map([['https://push.example/gone', 410]]);
  const center = createNotificationCenter({ db, repository: new DetailFlowRepository(db), pushSender: async (subscription, message, options) => {
    sent.push({ endpoint: subscription.endpoint, message, subject: options.subject, hasKey: Boolean(options.vapid.privateKey) });
    return answers.get(subscription.endpoint) ?? 201;
  } });
  const phone = browser();
  assert.equal(center.subscribePush('tenant_demo', 'member_demo_owner', { endpoint: 'https://push.example/phone', keys: phone.keys }).kind, 'subscribed');
  assert.equal(center.subscribePush('tenant_demo', 'member_demo_owner', { endpoint: 'https://push.example/gone', keys: browser().keys }).kind, 'subscribed');
  assert.equal(center.subscribePush('tenant_demo', 'member_demo_owner', { endpoint: 'http://insecure', keys: phone.keys }).kind, 'invalid');

  await center.deliver('tenant_demo', ['member_demo_owner'], { kind: 'booking_reminder', title: 'Через 1 час запись', body: '12:00 · Toyota Camry · 1 ч 30 мин', link: '/bookings/bk_1' });
  assert.deepEqual(sent.map((item) => item.endpoint).sort(), ['https://push.example/gone', 'https://push.example/phone']);
  assert.deepEqual(sent[0].message, { title: 'Через 1 час запись', body: '12:00 · Toyota Camry · 1 ч 30 мин', link: '/bookings/bk_1', kind: 'booking_reminder' });
  assert.ok(sent.every((item) => item.hasKey && item.subject === 'https://detailflow.ru'));
  assert.deepEqual(db.prepare('SELECT endpoint FROM push_subscriptions').all().map((row) => row.endpoint), ['https://push.example/phone'], 'the forgotten device is gone');
  assert.equal(center.vapidKeys().publicKey, center.vapidKeys().publicKey, 'the key pair is made once and kept');
  db.close();
});

test('a member subscribes this device over the API and unsubscribes it; the demo cannot', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, authTokens: new Map([
    ['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin'] }],
    ['owner-token', { tenantId: 'tenant_demo', displayName: 'Анна Смирнова', roles: ['owner', 'admin'], memberId: 'member_demo_owner' }]
  ]) });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const api = (path, token, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  try {
    const { publicKey } = await (await api('/api/notifications/push-key', 'owner-token')).json();
    assert.equal(Buffer.from(publicKey, 'base64url').length, 65, 'an uncompressed P-256 point for applicationServerKey');
    const subscription = { endpoint: 'https://push.example/laptop', keys: browser().keys };
    assert.equal((await api('/api/notifications/push', 'owner-token', { method: 'POST', body: JSON.stringify(subscription) })).status, 200);
    assert.equal((await api('/api/notifications/push', 'owner-token', { method: 'POST', body: JSON.stringify({ endpoint: 'https://x' }) })).status, 422);
    assert.deepEqual(await (await api('/api/notifications/push/remove', 'owner-token', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) })).json(), { removed: true });
    assert.equal((await api('/api/notifications/push', 'demo-session-token', { method: 'POST', body: JSON.stringify(subscription) })).status, 409);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
