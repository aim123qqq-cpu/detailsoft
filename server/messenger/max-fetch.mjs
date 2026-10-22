import { Agent, request } from 'node:https';
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

// The MAX API (platform-api.max.ru) is signed by the Russian Trusted Root CA of the Ministry of Digital
// Development, which Node.js does not ship. It is trusted here for MAX requests only; the rest of the
// server keeps the usual list. The certificate is public (gu-st.ru), SHA-256 D2:6D:2D:02…:CA:8E:CF:31.
const russianRoot = readFileSync(new URL('./russian-trusted-root-ca.pem', import.meta.url), 'utf8');
const agent = new Agent({ keepAlive: true, ca: [...rootCertificates, russianRoot] });

/** A small fetch for the MAX adapter: method, headers, body and signal; the answer has ok, status and json(). */
export function maxFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method, headers, agent, signal }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
