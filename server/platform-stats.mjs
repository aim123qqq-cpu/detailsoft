// What the owner of the DetailFlow service sees in /admin: counts across centers and the server's health.
// Only counts and center names — never the centers' customers (DetailFlow processes those on the
// centers' behalf and may not look at them for its own purposes).
import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem, uptime as systemUptime } from 'node:os';
import { dirname, resolve } from 'node:path';
import { REQUEST_GROUPS, describeRequestKey } from './request-catalog.mjs';

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

const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const HOUR = 3_600_000; const DAY = 24 * HOUR;
/** The service counts days the way its people live them: by Moscow time. */
const moscowDay = (ms) => new Date(ms + 3 * HOUR).toISOString().slice(0, 10);
const moscowDayStart = (day) => Date.parse(`${day}T00:00:00+03:00`);
const VALID_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Counted as requests finish and written to the database every half a minute: the breakdown of requests by
 * kind (10-minute buckets, any period) and who really worked on which day.
 */
export function createRequestLedger(db, now = () => Date.now()) {
  const requests = new Map();
  const people = new Map();
  return {
    record(key, statusCode, durationMs) {
      const bucket = sqlTime(Math.floor(now() / 600_000) * 600_000);
      const id = `${bucket}|${key}`;
      const entry = requests.get(id) ?? { bucket, key, requests: 0, clientErrors: 0, serverErrors: 0, slow: 0, totalMs: 0 };
      entry.requests += 1;
      if (statusCode >= 500) entry.serverErrors += 1;
      else if (statusCode >= 400) entry.clientErrors += 1;
      if (durationMs > 2000) entry.slow += 1;
      entry.totalMs += Math.round(durationMs);
      requests.set(id, entry);
    },
    touch(tenantId, memberId, changed) {
      const at = sqlTime(now());
      const day = moscowDay(now());
      const id = `${day}|${tenantId}|${memberId}`;
      const entry = people.get(id) ?? { day, tenantId, memberId, requests: 0, changes: 0, lastAt: at, lastChangeAt: null };
      entry.requests += 1;
      entry.lastAt = at;
      if (changed) { entry.changes += 1; entry.lastChangeAt = at; }
      people.set(id, entry);
    },
    flush() {
      if (!requests.size && !people.size) return;
      db.exec('BEGIN');
      try {
        const addRequests = db.prepare(`INSERT INTO platform_request_stats (bucket, route, requests, client_errors, server_errors, slow, total_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(bucket, route) DO UPDATE SET requests = requests + excluded.requests, client_errors = client_errors + excluded.client_errors,
            server_errors = server_errors + excluded.server_errors, slow = slow + excluded.slow, total_ms = total_ms + excluded.total_ms`);
        for (const entry of requests.values()) addRequests.run(entry.bucket, entry.key, entry.requests, entry.clientErrors, entry.serverErrors, entry.slow, entry.totalMs);
        const addPeople = db.prepare(`INSERT INTO platform_member_days (day, tenant_id, member_id, requests, changes, last_at, last_change_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(day, tenant_id, member_id) DO UPDATE SET requests = requests + excluded.requests, changes = changes + excluded.changes,
            last_at = excluded.last_at, last_change_at = COALESCE(excluded.last_change_at, last_change_at)`);
        for (const entry of people.values()) addPeople.run(entry.day, entry.tenantId, entry.memberId, entry.requests, entry.changes, entry.lastAt, entry.lastChangeAt);
        db.exec('COMMIT');
        requests.clear();
        people.clear();
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    /** Requests by kind are kept for 90 days, days of work for two years. */
    purge() {
      db.prepare('DELETE FROM platform_request_stats WHERE bucket < ?').run(sqlTime(now() - 90 * DAY));
      db.prepare('DELETE FROM platform_member_days WHERE day < ?').run(moscowDay(now() - 730 * DAY));
    }
  };
}

const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

/** A named period or any dates: the bounds in UTC for the database, the days in Moscow time for people. */
export function parsePeriod(params, db, now = Date.now()) {
  // The end is exclusive and times have whole seconds: what happened this very second is inside.
  const end = now + 1000;
  const today = moscowDay(now);
  let preset = params.get('preset') ?? '';
  let fromMs; let toMs = end;
  const from = params.get('from'); const to = params.get('to');
  if (from && to && VALID_DAY.test(from) && VALID_DAY.test(to) && !Number.isNaN(Date.parse(from)) && !Number.isNaN(Date.parse(to))) {
    const [first, last] = from <= to ? [from, to] : [to, from];
    preset = 'custom';
    fromMs = moscowDayStart(first);
    toMs = Math.min(end, moscowDayStart(last) + DAY);
  } else if (preset === 'hour') fromMs = now - HOUR;
  else if (preset === 'today') fromMs = moscowDayStart(today);
  else if (preset === 'yesterday') { fromMs = moscowDayStart(today) - DAY; toMs = moscowDayStart(today); }
  else if (preset === 'all') {
    const first = db.prepare(`SELECT MIN(at) AS at FROM (SELECT MIN(created_at) AS at FROM center_signups UNION ALL SELECT MIN(created_at) FROM bookings UNION ALL SELECT MIN(created_at) FROM orders)`).get().at;
    fromMs = first ? moscowDayStart(moscowDay(Date.parse(`${first.replace(' ', 'T').slice(0, 19)}Z`))) : moscowDayStart(today);
  } else {
    if (!PRESET_DAYS[preset]) preset = '30d';
    fromMs = moscowDayStart(today) - (PRESET_DAYS[preset] - 1) * DAY;
  }
  return { preset, from: sqlTime(fromMs), to: sqlTime(toMs), fromMs, toMs, fromDay: moscowDay(fromMs), toDay: moscowDay(toMs - 1) };
}

// Not real work: the demo centers, the center for the store's moderators, and what the owner marked as a test.
const REVIEW_CENTER = 'Тестовый центр для проверки';
const SKIPPED = `(SELECT id FROM tenants WHERE id IN ('tenant_demo', 'tenant_other') OR name = '${REVIEW_CENTER}' UNION SELECT tenant_id FROM platform_excluded_centers)`;
const inPeriod = (column) => `datetime(${column}) >= ? AND datetime(${column}) < ?`;

/** What a center is really doing: a center's life in one word, from what it has done, not from how often it signed in. */
function stageOf(center, now) {
  const last = center.lastWorkAt ? Date.parse(`${center.lastWorkAt.replace(' ', 'T').slice(0, 19)}Z`) : 0;
  const worked = center.allBookings + center.allOrders;
  if (!center.services && !worked) return ['new', 'Только создан', 'Услуги не добавлены, записей и заказов нет. Человек зарегистрировался и дальше не пошёл.'];
  if (!worked) return ['setup', 'Настраивается', 'Услуги есть, но ни одной записи или заказа ещё не было.'];
  if (now - last > 14 * DAY) return ['silent', 'Затих', 'Работал, но больше 14 дней нет новых записей и заказов.'];
  if (center.allClosed >= 3 && now - last <= 7 * DAY) return ['working', 'Работает', 'Выдано больше 3 автомобилей, и на этой неделе есть новая работа.'];
  return ['trying', 'Пробует', 'Есть записи или заказы, но автомобилей выдано пока мало: сервис только пробуют.'];
}

function centers(db, period) {
  const range = [period.from, period.to];
  const rows = db.prepare(`SELECT t.id, t.name, s.created_at AS signedUpAt, s.provider AS signedUpWith,
      t.id IN ${SKIPPED} AS skipped,
      (SELECT COUNT(*) FROM tenant_members m WHERE m.tenant_id = t.id AND m.status = 'active') AS members,
      (SELECT COUNT(*) FROM tenant_services v WHERE v.tenant_id = t.id AND v.active = 1) AS services,
      (SELECT MIN(created_at) FROM tenant_members m WHERE m.tenant_id = t.id) AS firstMemberAt,
      (SELECT COUNT(*) FROM customers c WHERE c.tenant_id = t.id) AS customers,
      (SELECT COUNT(*) FROM customers c WHERE c.tenant_id = t.id AND c.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id) AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)) AS customersWithoutBooking,
      (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id) AS allBookings,
      (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = t.id) AS allOrders,
      (SELECT COUNT(*) FROM order_handovers h WHERE h.tenant_id = t.id) AS allClosed,
      (SELECT COUNT(*) FROM order_documents d WHERE d.tenant_id = t.id) AS documents,
      (SELECT COUNT(*) FROM customers c WHERE c.tenant_id = t.id AND ${inPeriod('c.created_at')}) AS newCustomers,
      (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND ${inPeriod('b.created_at')}) AS bookings,
      (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.status = 'CANCELLED' AND ${inPeriod('b.created_at')}) AS cancelled,
      (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = t.id AND ${inPeriod('o.created_at')}) AS orders,
      (SELECT COUNT(*) FROM order_handovers h WHERE h.tenant_id = t.id AND ${inPeriod('h.handed_over_at')}) AS closed,
      (SELECT COUNT(*) FROM order_documents d WHERE d.tenant_id = t.id AND ${inPeriod('d.created_at')}) AS periodDocuments,
      (SELECT COUNT(DISTINCT member_id) FROM (
        SELECT member_id FROM platform_member_days p WHERE p.tenant_id = t.id AND p.day >= ? AND p.day <= ?
        UNION SELECT member_id FROM auth_sessions a WHERE a.tenant_id = t.id AND ${inPeriod('a.created_at')})) AS activePeople,
      (SELECT COALESCE(SUM(requests), 0) FROM platform_member_days p WHERE p.tenant_id = t.id AND p.day >= ? AND p.day <= ?) AS requests,
      (SELECT COALESCE(SUM(changes), 0) FROM platform_member_days p WHERE p.tenant_id = t.id AND p.day >= ? AND p.day <= ?) AS changes,
      (SELECT MAX(last_at) FROM platform_member_days p WHERE p.tenant_id = t.id) AS lastSeenAt,
      MAX(COALESCE((SELECT MAX(created_at) FROM bookings b WHERE b.tenant_id = t.id), ''),
          COALESCE((SELECT MAX(created_at) FROM orders o WHERE o.tenant_id = t.id), ''),
          COALESCE((SELECT MAX(created_at) FROM order_documents d WHERE d.tenant_id = t.id), ''),
          COALESCE((SELECT MAX(handed_over_at) FROM order_handovers h WHERE h.tenant_id = t.id), '')) AS lastWorkAt
    FROM tenants t LEFT JOIN center_signups s ON s.tenant_id = t.id
    ORDER BY skipped, lastWorkAt DESC, t.name`).all(...range, ...range, ...range, ...range, ...range, ...range,
    period.fromDay, period.toDay, ...range, period.fromDay, period.toDay, period.fromDay, period.toDay);
  const now = Date.now();
  return rows.map((row) => {
    const center = { ...row, skipped: Boolean(row.skipped), lastWorkAt: row.lastWorkAt || null, createdAt: row.signedUpAt ?? row.firstMemberAt };
    // Older code and tests read these under their first names.
    center.lastActivityAt = center.lastSeenAt && center.lastSeenAt > (center.lastWorkAt ?? '') ? center.lastSeenAt : center.lastWorkAt;
    const [stage, stageTitle, stageMeaning] = stageOf(center, now);
    return { ...center, stage, stageTitle, stageMeaning, workedInPeriod: center.bookings + center.orders + center.closed + center.periodDocuments + center.changes > 0 };
  });
}

function users(db) {
  const since = (days) => `datetime('now', '-${days} days')`;
  const active = (days) => count(db, `SELECT COUNT(DISTINCT member_id) AS count FROM auth_sessions WHERE created_at > ${since(days)}`);
  return {
    members: count(db, `SELECT COUNT(*) AS count FROM tenant_members WHERE status = 'active' AND tenant_id NOT IN ${SKIPPED}`),
    signedInDay: active(1),
    signedInWeek: active(7),
    signedInMonth: active(30),
    signInsDay: count(db, `SELECT COUNT(*) AS count FROM auth_sessions WHERE created_at > ${since(1)}`),
    byProvider: db.prepare(`SELECT provider, COUNT(DISTINCT external_user_id) AS accounts FROM member_messenger_links GROUP BY provider`).all(),
    accessCodes: count(db, 'SELECT COUNT(*) AS count FROM tenant_member_tokens')
  };
}

/** The numbers of a period, without the centers that are not real work. */
function summary(db, from, to, fromDay, toDay) {
  const of = (table, column = 'created_at', extra = '') => count(db, `SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id NOT IN ${SKIPPED} ${extra} AND ${inPeriod(column)}`, from, to);
  return {
    newCenters: of('center_signups'),
    newCustomers: of('customers'),
    bookings: of('bookings'),
    cancelled: of('bookings', 'created_at', "AND status = 'CANCELLED'"),
    orders: of('orders'),
    closed: of('order_handovers', 'handed_over_at'),
    documents: of('order_documents'),
    activePeople: count(db, `SELECT COUNT(DISTINCT member_id) AS count FROM (
      SELECT member_id, tenant_id FROM platform_member_days WHERE day >= ? AND day <= ?
      UNION SELECT member_id, tenant_id FROM auth_sessions WHERE ${inPeriod('created_at')}) WHERE tenant_id NOT IN ${SKIPPED}`, fromDay, toDay, from, to)
  };
}

const monthKey = (day) => day.slice(0, 7);
const weekKey = (day) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
};

/** How finely to draw a period: hours for a day or two, then days, weeks, months. */
function granularityOf(days) {
  return days <= 2 ? 'hour' : days <= 92 ? 'day' : days <= 400 ? 'week' : 'month';
}

/** Bookings, orders, acts, closed orders and new centers across the period (Moscow time), oldest first. */
function activity(db, period) {
  const days = Math.max(1, Math.round((moscowDayStart(period.toDay) - moscowDayStart(period.fromDay)) / DAY) + 1);
  const granularity = granularityOf(days);
  const format = granularity === 'hour' ? '%Y-%m-%d %H' : '%Y-%m-%d';
  const keyOf = granularity === 'week' ? weekKey : granularity === 'month' ? monthKey : (value) => value;
  const buckets = new Map();
  const empty = () => ({ bookings: 0, orders: 0, closed: 0, documents: 0, centers: 0 });
  // Every step is on the chart, empty ones too: a quiet week should look quiet, not disappear.
  for (let index = 0; index < days; index += 1) {
    const day = moscowDay(moscowDayStart(period.fromDay) + index * DAY);
    if (granularity === 'hour') for (let hour = 0; hour < 24; hour += 1) buckets.set(`${day} ${String(hour).padStart(2, '0')}`, empty());
    else buckets.set(keyOf(day), empty());
  }
  const series = { bookings: ['bookings', 'created_at'], orders: ['orders', 'created_at'], closed: ['order_handovers', 'handed_over_at'], documents: ['order_documents', 'created_at'], centers: ['center_signups', 'created_at'] };
  for (const [name, [table, column]] of Object.entries(series)) {
    const rows = db.prepare(`SELECT strftime('${format}', ${column}, '+3 hours') AS at, COUNT(*) AS count FROM ${table}
      WHERE tenant_id NOT IN ${SKIPPED} AND ${inPeriod(column)} GROUP BY at`).all(period.from, period.to);
    for (const row of rows) {
      const bucket = buckets.get(keyOf(row.at));
      if (bucket) bucket[name] += row.count;
    }
  }
  return { granularity, points: [...buckets].map(([day, values]) => ({ day, ...values })) };
}

/** Which requests come to the server over the period, by kind. People first; the admin's own polling apart. */
function requestBreakdown(db, period) {
  const floor = sqlTime(Math.floor(period.fromMs / 600_000) * 600_000);
  const rows = db.prepare(`SELECT route, SUM(requests) AS requests, SUM(client_errors) AS clientErrors, SUM(server_errors) AS serverErrors, SUM(slow) AS slow, SUM(total_ms) AS totalMs
    FROM platform_request_stats WHERE bucket >= ? AND bucket < ? GROUP BY route`).all(floor, period.to);
  const groups = new Map(Object.entries(REQUEST_GROUPS).map(([id, title]) => [id, { id, title, requests: 0, clientErrors: 0, serverErrors: 0, slow: 0, routes: [] }]));
  for (const row of rows) {
    const { group, label, address } = describeRequestKey(row.route);
    const entry = groups.get(group) ?? groups.get('unknown');
    entry.requests += row.requests; entry.clientErrors += row.clientErrors; entry.serverErrors += row.serverErrors; entry.slow += row.slow;
    entry.routes.push({ label, address, requests: row.requests, clientErrors: row.clientErrors, serverErrors: row.serverErrors, slow: row.slow, averageMs: Math.round(row.totalMs / row.requests) });
  }
  const list = [...groups.values()].filter((group) => group.requests);
  for (const group of list) group.routes.sort((a, b) => b.requests - a.requests);
  const sum = (ids, key = 'requests') => list.filter((group) => ids.includes(group.id)).reduce((total, group) => total + group[key], 0);
  const bySteps = db.prepare(`SELECT bucket, route, requests, server_errors AS errors FROM platform_request_stats WHERE bucket >= ? AND bucket < ?`).all(floor, period.to);
  const span = period.toMs - period.fromMs;
  const size = span <= 6 * HOUR ? 600_000 : span <= 3 * DAY ? HOUR : span <= 92 * DAY ? DAY : 7 * DAY;
  const steps = new Map();
  for (let at = Math.floor(period.fromMs / size) * size; at < period.toMs; at += size) steps.set(at, { at: new Date(at).toISOString(), people: 0, other: 0, errors: 0 });
  for (const row of bySteps) {
    const step = steps.get(Math.floor(Date.parse(`${row.bucket.replace(' ', 'T')}Z`) / size) * size);
    if (!step) continue;
    const { group } = describeRequestKey(row.route);
    if (['work', 'signin', 'site'].includes(group)) step.people += row.requests; else step.other += row.requests;
    step.errors += row.errors;
  }
  return {
    total: sum(['work', 'signin', 'site', 'admin', 'service', 'unknown']),
    people: sum(['work', 'signin', 'site']),
    errors: sum(['work', 'signin', 'site', 'admin', 'service', 'unknown'], 'serverErrors'),
    groups: list,
    series: [...steps.values()]
  };
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

export function platformStats({ db, databasePath, backupDirectory, version, bots, metrics, ledger, period }) {
  ledger?.flush();
  const list = centers(db, period);
  const real = list.filter((center) => !center.skipped);
  const chart = activity(db, period);
  // The same length just before, to see whether things go up or down.
  const span = period.toMs - period.fromMs;
  const previousFrom = period.fromMs - span;
  const stages = {};
  for (const center of real) stages[center.stage] = (stages[center.stage] ?? 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    version,
    period: { preset: period.preset, from: period.fromDay, to: period.toDay },
    centers: { total: real.length, workedInPeriod: real.filter((center) => center.workedInPeriod).length, activeWeek: real.filter((center) => center.lastActivityAt && Date.parse(`${center.lastActivityAt.replace(' ', 'T').slice(0, 19)}Z`) > Date.now() - 7 * 86_400_000).length, stages, list },
    users: users(db),
    summary: summary(db, period.from, period.to, period.fromDay, period.toDay),
    previous: summary(db, sqlTime(previousFrom), period.from, moscowDay(previousFrom), moscowDay(period.fromMs - 1)),
    totals: {
      customers: count(db, `SELECT COUNT(*) AS count FROM customers WHERE tenant_id NOT IN ${SKIPPED}`),
      bookings: count(db, `SELECT COUNT(*) AS count FROM bookings WHERE tenant_id NOT IN ${SKIPPED}`),
      orders: count(db, `SELECT COUNT(*) AS count FROM orders WHERE tenant_id NOT IN ${SKIPPED}`),
      documents: count(db, `SELECT COUNT(*) AS count FROM order_documents WHERE tenant_id NOT IN ${SKIPPED}`)
    },
    activity: chart.points,
    activityGranularity: chart.granularity,
    bots,
    requests: metrics.lastHour(),
    requestBreakdown: requestBreakdown(db, period),
    system: systemHealth({ databasePath, backupDirectory })
  };
}
