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
  backupDirectory,
  ...demoAuthOptions()
});
if (messengers.length) console.log(`Messenger sign-in: ${messengers.map((adapter) => adapter.title).join(', ')}`);

if (backupIntervalHours > 0) {
  const timer = setInterval(() => {
    backupDatabaseFile(databasePath, backupDirectory, { reason: 'daily', keep: backupKeep })
      .then((file) => console.log(`Scheduled backup: ${file}`))
      .catch((error) => {
        console.error('Scheduled backup failed:', error.message);
        void server.notifyAdmins(`⚠️ DetailFlow: резервная копия базы не создалась — ${error.message}`, 'backup');
      });
  }, backupIntervalHours * 60 * 60 * 1000);
  server.on('close', () => clearInterval(timer));
}

// Behind a reverse proxy on the same machine keep the default; HOST=0.0.0.0 exposes the port directly.
const host = process.env.HOST ?? '127.0.0.1';
server.listen(port, host, () => {
  console.log(`DetailFlow is running at http://${host}:${port}`);
});

// Graceful stop for systemd/Docker/Ctrl+C: finish open requests, stop bots, close the database.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, stopping DetailFlow`);
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
