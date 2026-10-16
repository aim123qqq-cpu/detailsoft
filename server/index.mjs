import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDetailFlowServer } from './app.mjs';
import { backupDatabaseFile } from './backup.mjs';
import { demoAuthOptions, messengersFromEnv } from './messenger/from-env.mjs';

mkdirSync(resolve('data'), { recursive: true });
const port = Number(process.env.PORT ?? 4173);
const databasePath = process.env.DATABASE_PATH ?? resolve('data/detailflow.db');
const backupDirectory = process.env.BACKUP_DIR ?? resolve('data/backups');
const backupKeep = Number(process.env.BACKUP_KEEP ?? 14);
const backupIntervalHours = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);

// A copy is taken before migrations run, so a failed upgrade can always be rolled back.
const startupBackup = await backupDatabaseFile(databasePath, backupDirectory, { reason: 'startup', keep: backupKeep });
if (startupBackup) console.log(`Backup before start: ${startupBackup}`);

const messengers = messengersFromEnv();
const server = createDetailFlowServer({
  databasePath,
  seed: process.env.SEED_DEMO !== 'false',
  staticDir: resolve('dist'),
  features: { qualityControl: process.env.ENABLE_QC === 'true' },
  messengers,
  ...demoAuthOptions()
});
if (messengers.length) console.log(`Messenger sign-in: ${messengers.map((adapter) => adapter.title).join(', ')}`);

if (backupIntervalHours > 0) {
  const timer = setInterval(() => {
    backupDatabaseFile(databasePath, backupDirectory, { reason: 'daily', keep: backupKeep })
      .then((file) => console.log(`Scheduled backup: ${file}`))
      .catch((error) => console.error('Scheduled backup failed:', error.message));
  }, backupIntervalHours * 60 * 60 * 1000);
  server.on('close', () => clearInterval(timer));
}

server.listen(port, '127.0.0.1', () => {
  console.log(`DetailFlow is running at http://127.0.0.1:${port}`);
});
