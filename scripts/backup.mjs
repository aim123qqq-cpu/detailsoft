// Usage: pnpm backup            — make a backup now
//        pnpm backup -- --list  — list existing backups
import { resolve } from 'node:path';
import { backupDatabaseFile, listBackups } from '../server/backup.mjs';

const databasePath = process.env.DATABASE_PATH ?? resolve('data/detailflow.db');
const directory = process.env.BACKUP_DIR ?? resolve('data/backups');

if (process.argv.includes('--list')) {
  const backups = listBackups(directory);
  if (!backups.length) console.log(`Копий нет в ${directory}`);
  for (const item of backups) console.log(`${item.name}  ${(item.size / 1024).toFixed(0)} КБ`);
} else {
  const file = await backupDatabaseFile(databasePath, directory, { reason: 'manual', keep: Number(process.env.BACKUP_KEEP ?? 14) });
  console.log(file ? `Копия создана: ${file}` : `База ${databasePath} ещё не создана — копировать нечего`);
}
