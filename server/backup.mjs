import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const SQLITE_HEADER = 'SQLite format 3\u0000';
const pad = (value) => String(value).padStart(2, '0');
const stamp = (date) => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;

/** Backups in a directory, newest first. File names carry a UTC timestamp, so name order is time order. */
export function listBackups(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^detailflow-\d{8}-\d{6}-[\w-]+\.db$/.test(name))
    .sort()
    .reverse()
    .map((name) => ({ name, path: join(directory, name), size: statSync(join(directory, name)).size }));
}

/**
 * Online SQLite backup of a database file (safe while the server writes to it).
 * Returns the new file path, or null when there is no database yet (fresh install).
 */
export async function backupDatabaseFile(databasePath, directory, { reason = 'manual', keep = 14, now = new Date() } = {}) {
  if (!existsSync(databasePath)) return null;
  mkdirSync(directory, { recursive: true });
  const safeReason = String(reason).replace(/[^\w-]/g, '-').slice(0, 40) || 'manual';
  const target = join(directory, `detailflow-${stamp(now)}-${safeReason}.db`);
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await backup(source, target);
  } finally {
    source.close();
  }
  for (const old of listBackups(directory).slice(Math.max(1, keep))) rmSync(old.path, { force: true });
  return target;
}

/**
 * Replaces the database with a backup. The current file is first backed up itself, so a restore
 * can always be undone. The server must be stopped: the caller is responsible for that check.
 */
export async function restoreDatabaseFile(backupPath, databasePath, directory) {
  if (!existsSync(backupPath)) throw new Error(`Файл копии не найден: ${backupPath}`);
  const header = readFileSync(backupPath).subarray(0, SQLITE_HEADER.length).toString('latin1');
  if (header !== SQLITE_HEADER) throw new Error(`${basename(backupPath)} не является базой SQLite`);
  const check = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const integrity = check.prepare('PRAGMA integrity_check').get();
    if (Object.values(integrity)[0] !== 'ok') throw new Error('Копия повреждена: проверка целостности SQLite не пройдена');
  } finally {
    check.close();
  }
  const previous = await backupDatabaseFile(databasePath, directory, { reason: 'before-restore', keep: Number.MAX_SAFE_INTEGER });
  for (const suffix of ['-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true });
  copyFileSync(backupPath, databasePath);
  return { restored: databasePath, previous };
}
