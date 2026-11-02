// Web Push without libraries: the VAPID signature (RFC 8292) and the aes128gcm message encryption
// (RFC 8291, RFC 8188) on node:crypto. A browser gives us an endpoint of its push service and two keys;
// the message is encrypted for that browser, so the push service (Google, Apple, Mozilla) only relays it.
import { createECDH, createPrivateKey, createSign, randomBytes, hkdfSync, createCipheriv } from 'node:crypto';

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const fromB64url = (text) => Buffer.from(text, 'base64url');

/** A new VAPID key pair: the public key goes to browsers, the private one signs our requests. */
export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

/** The Authorization header for a push service: a short-lived JWT signed with the VAPID private key. */
export function vapidAuthorization(endpoint, { publicKey, privateKey }, subject, now = Date.now()) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const point = fromB64url(publicKey);
  const key = createPrivateKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', d: privateKey, x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65))
  } });
  const signature = createSign('SHA256').update(`${header}.${claims}`).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
}

/** Encrypts a message for one browser subscription (one aes128gcm record). */
export function encryptForSubscription(plaintext, { p256dh, auth }, { salt = randomBytes(16), ephemeral = null } = {}) {
  const receiverKey = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const sender = ephemeral ?? createECDH('prime256v1');
  if (!ephemeral) sender.generateKeys();
  const senderKey = sender.getPublicKey();
  const shared = sender.computeSecret(receiverKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverKey, senderKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const contentKey = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  // The last (and only) record ends with the 0x02 delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([senderKey.length]), senderKey, body]);
}

/**
 * Sends a message to a browser subscription. Resolves with the push service's status: 201 delivered,
 * 404 or 410 means the subscription is gone (the browser unsubscribed or was reset).
 */
export async function sendWebPush(subscription, message, { vapid, subject, fetchImpl = fetch, ttl = 24 * 3600 }) {
  const response = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(subscription.endpoint, vapid, subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency: 'normal'
    },
    body: encryptForSubscription(JSON.stringify(message), subscription)
  });
  return response.status;
}
