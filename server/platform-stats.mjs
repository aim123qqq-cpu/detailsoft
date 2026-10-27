// What the owner of the DetailFlow service sees in /admin: counts across centers and the server's health.
// Only counts and center names — never the centers' customers (DetailFlow processes those on the
// centers' behalf and may not look at them for its own purposes).
import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem, uptime as systemUptime } from 'node:os';
import { dirname, resolve } from 'node:path';

/** Requests and server errors per minute for the last hour, counted as responses finish. */
export function createRequestMetrics(now = () => Date.now()) {
  const minutes = new Map();
  const bucket = () => Math.floor(now() / 60_000);
  return {
    record(statusCode, durationMs) {
      const key = bucket();
      const entry = minutes.get(key) ?? { requests: 0, errors: 0, slow: 0 };
      entry.requests += 1;
      if (statusCode >= 500) entry.errors += 1;
      if (durationMs > 2000) entry.slow += 1;
      minutes.set(key, entry);
      for (const old of minutes.keys()) if (old < key - 60) minutes.delete(old);
    },
    /** Oldest first: 60 minutes ending with the current one. */
    lastHour() {
      const current = bucket();
      return Array.from({ length: 60 }, (_, index) => {
        const key = current - 59 + index;
        return { minute: new Date(key * 60_000).toISOString(), ...(minutes.get(key) ?? { requests: 0, errors: 0, slow: 0 }) };
      });
    }
  };
}

const count = (db, sql, ...params) => db.prepare(sql).get(...params).count;

function centers(db) {
  return db.prepare(`SELECT t.id, t.name, s.created_at AS signedUpAt, s.provider AS signedUpWith,
      (SELECT COUNT(*) FROM tenant_members m WHERE m.tenant_id = t.id AND m.status = 'active') AS members,
      (SELECT COUNT(*) FROM customers c WHERE c.tenant_id = t.id) AS customers,
      (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id) AS bookings,
      (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = t.id) AS orders,
      (SELECT COUNT(*) FROM order_documents d WHERE d.tenant_id = t.id) AS documents,
      (SELECT COUNT(*) FROM tenant_services v WHERE v.tenant_id = t.id AND v.active = 1) AS services,
      MAX(COALESCE((SELECT MAX(created_at) FROM bookings b WHERE b.tenant_id = t.id), ''),
          COALESCE((SELECT MAX(created_at) FROM orders o WHERE o.tenant_id = t.id), ''),
          COALESCE((SELECT MAX(created_at) FROM auth_sessions a WHERE a.tenant_id = t.id), '')) AS lastActivityAt
    FROM tenants t LEFT JOIN center_signups s ON s.tenant_id = t.id
    ORDER BY lastActivityAt DESC, t.name`).all().map((row) => ({ ...row, lastActivityAt: row.lastActivityAt || null }));
}

function users(db) {
  const since = (days) => `datetime('now', '-${days} days')`;
  const active = (days) => count(db, `SELECT COUNT(DISTINCT member_id) AS count FROM auth_sessions WHERE created_at > ${since(days)}`);
  return {
    members: count(db, `SELECT COUNT(*) AS count FROM tenant_members WHERE status = 'active'`),
    signedInDay: active(1),
    signedInWeek: active(7),
    signedInMonth: active(30),
    signInsDay: count(db, `SELECT COUNT(*) AS count FROM auth_sessions WHERE created_at > ${since(1)}`),
    byProvider: db.prepare(`SELECT provider, COUNT(DISTINCT external_user_id) AS accounts FROM member_messenger_links GROUP BY provider`).all(),
    accessCodes: count(db, 'SELECT COUNT(*) AS count FROM tenant_member_tokens')
  };
}

/** Bookings, orders and acts created per day for the last 30 days (UTC dates), oldest first. */
function activity(db) {
  const perDay = (table) => new Map(db.prepare(`SELECT date(created_at) AS day, COUNT(*) AS count FROM ${table}
    WHERE created_at > datetime('now', '-30 days') GROUP BY day`).all().map((row) => [row.day, row.count]));
  const bookings = perDay('bookings'); const orders = perDay('orders'); const documents = perDay('order_documents');
  const centersMade = perDay('center_signups');
  return Array.from({ length: 30 }, (_, index) => {
    const day = new Date(Date.now() - (29 - index) * 86_400_000).toISOString().slice(0, 10);
    return { day, bookings: bookings.get(day) ?? 0, orders: orders.get(day) ?? 0, documents: documents.get(day) ?? 0, centers: centersMade.get(day) ?? 0 };
  });
}

function disk(path) {
  try {
    const stats = statfsSync(path);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch { return null; }
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function backups(directory) {
  if (!existsSync(directory)) return { count: 0, latestAt: null, totalBytes: 0 };
  const files = readdirSync(directory).filter((name) => name.endsWith('.db')).map((name) => statSync(resolve(directory, name)));
  const latest = files.reduce((newest, file) => (!newest || file.mtimeMs > newest.mtimeMs ? file : newest), null);
  return { count: files.length, latestAt: latest ? latest.mtime.toISOString() : null, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
}

export function systemHealth({ databasePath, backupDirectory }) {
  const memory = process.memoryUsage();
  const onDisk = databasePath && databasePath !== ':memory:';
  return {
    cpuCount: cpus().length,
    loadAverage: loadavg(),
    memory: { totalBytes: totalmem(), freeBytes: freemem(), processBytes: memory.rss },
    disk: onDisk ? disk(dirname(resolve(databasePath))) : disk(process.cwd()),
    databaseBytes: onDisk ? fileSize(databasePath) + fileSize(`${databasePath}-wal`) : 0,
    backups: backups(backupDirectory),
    processUptimeSeconds: Math.round(process.uptime()),
    systemUptimeSeconds: Math.round(systemUptime()),
    node: process.version
  };
}

export function platformStats({ db, databasePath, backupDirectory, version, bots, metrics }) {
  const list = centers(db);
  return {
    generatedAt: new Date().toISOString(),
    version,
    centers: { total: list.length, activeWeek: list.filter((center) => center.lastActivityAt && Date.parse(`${center.lastActivityAt.replace(' ', 'T')}Z`) > Date.now() - 7 * 86_400_000).length, list },
    users: users(db),
    totals: {
      customers: count(db, 'SELECT COUNT(*) AS count FROM customers'),
      bookings: count(db, 'SELECT COUNT(*) AS count FROM bookings'),
      orders: count(db, 'SELECT COUNT(*) AS count FROM orders'),
      documents: count(db, 'SELECT COUNT(*) AS count FROM order_documents')
    },
    activity: activity(db),
    bots,
    requests: metrics.lastHour(),
    system: systemHealth({ databasePath, backupDirectory })
  };
}
