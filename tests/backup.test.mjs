import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../server/db.mjs';
import { backupDatabaseFile, listBackups, restoreDatabaseFile } from '../server/backup.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'df-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const countCustomers = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) count FROM customers').get().count; } finally { db.close(); }
};

test('an online backup is a consistent, openable copy even while the database is open', async (t) => {
  const dir = workspace(t);
  const dbPath = join(dir, 'detailflow.db');
  const live = openDatabase(dbPath, { seed: true });
  live.prepare(`INSERT INTO customers (id, tenant_id, name, phone_display, phone_normalized) VALUES ('cust_b', 'tenant_demo', 'Копия', '+7 900 000-00-01', '79000000001')`).run();

  const created = await backupDatabaseFile(dbPath, join(dir, 'backups'), { reason: 'manual' });
  live.close();
  assert.match(created, /detailflow-\d{8}-\d{6}-manual\.db$/);
  assert.equal(countCustomers(created), countCustomers(dbPath));
  assert.equal(countCustomers(created), 3);
});

test('old backups are pruned to the configured count, newest kept', async (t) => {
  const dir = workspace(t);
  const dbPath = join(dir, 'detailflow.db');
  openDatabase(dbPath, { seed: true }).close();
  const backups = join(dir, 'backups');
  for (let index = 0; index < 4; index += 1) {
    await backupDatabaseFile(dbPath, backups, { reason: `run${index}`, keep: 2, now: new Date(Date.UTC(2026, 9, 16, 10, 0, index)) });
  }
  assert.deepEqual(listBackups(backups).map((item) => item.name), [
    'detailflow-20261016-100003-run3.db', 'detailflow-20261016-100002-run2.db'
  ]);
});

test('a missing database is not backed up (fresh install)', async (t) => {
  const dir = workspace(t);
  assert.equal(await backupDatabaseFile(join(dir, 'absent.db'), join(dir, 'backups')), null);
  assert.equal(existsSync(join(dir, 'backups')), false);
});

test('restore keeps the current database aside and refuses non-SQLite files', async (t) => {
  const dir = workspace(t);
  const dbPath = join(dir, 'detailflow.db');
  openDatabase(dbPath, { seed: true }).close();
  const snapshot = await backupDatabaseFile(dbPath, join(dir, 'backups'), { reason: 'before-change' });

  const live = new DatabaseSync(dbPath);
  live.exec(`DELETE FROM customer_vehicles; DELETE FROM leads; DELETE FROM orders; DELETE FROM customers`);
  live.close();
  assert.equal(countCustomers(dbPath), 0);

  const result = await restoreDatabaseFile(snapshot, dbPath, join(dir, 'backups'));
  assert.equal(countCustomers(dbPath), 2, 'restored data is back');
  assert.ok(result.previous && existsSync(result.previous), 'the replaced database was kept as a backup');
  assert.equal(countCustomers(result.previous), 0);

  const fake = join(dir, 'not-a-db.db');
  writeFileSync(fake, 'hello');
  await assert.rejects(() => restoreDatabaseFile(fake, dbPath, join(dir, 'backups')), /SQLite/);
  assert.equal(countCustomers(dbPath), 2, 'a failed restore changes nothing');
  assert.ok(readdirSync(join(dir, 'backups')).length >= 2);
});
