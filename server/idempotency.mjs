import { createHash } from 'node:crypto';

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const KEEP = '-7 days';

/**
 * Generic idempotency for mutating API requests carrying an Idempotency-Key header: the first
 * answer (anything but 5xx and 401) is stored per center and key, and a retry with the same
 * method, path and body gets that answer back without running the change again.
 */
export function createIdempotency(db) {
  const find = db.prepare('SELECT method, path, request_hash, status, response_body FROM api_idempotent_requests WHERE tenant_id = ? AND key = ?');
  const insert = db.prepare(`INSERT OR IGNORE INTO api_idempotent_requests
    (tenant_id, key, method, path, request_hash, status, response_body) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const purge = db.prepare(`DELETE FROM api_idempotent_requests WHERE created_at < datetime('now', '${KEEP}')`);

  /**
   * Returns 'replayed' when the stored answer was sent, 'conflict' for a key reused with another
   * request, or 'proceed' after arranging for the coming answer to be stored.
   */
  return async function handle({ request, response, tenantId, key, pathname }) {
    if (key.length > 120) return 'proceed';
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BUFFERED_BYTES) throw new Error('request_body_too_large');
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    // Route handlers read the body again from this buffer.
    request[Symbol.asyncIterator] = async function* replayBody() { if (body.length) yield body; };
    const hash = createHash('sha256').update(`${request.method} ${pathname}\n`).update(body).digest('hex');

    const stored = find.get(tenantId, key);
    if (stored) {
      if (stored.method !== request.method || stored.path !== pathname || stored.request_hash !== hash) {
        response.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: { code: 'idempotency_conflict', message: 'Ключ уже использован для другого запроса' } }));
        return 'conflict';
      }
      response.writeHead(stored.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'idempotent-replay': 'true' });
      response.end(stored.response_body);
      return 'replayed';
    }

    const end = response.end.bind(response);
    response.end = (chunk, ...rest) => {
      const status = response.statusCode;
      if (status < 500 && status !== 401 && chunk !== undefined) {
        try {
          insert.run(tenantId, key, request.method, pathname, hash, status, Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
          purge.run();
        } catch (error) {
          console.error('idempotency store failed:', error.message);
        }
      }
      return end(chunk, ...rest);
    };
    return 'proceed';
  };
}
