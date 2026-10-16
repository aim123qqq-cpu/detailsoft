// Usage: pnpm restore -- data/backups/detailflow-20261016-100000-daily.db
// The server must be stopped. The current database is backed up first, so a restore can be undone.
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { restoreDatabaseFile } from '../server/backup.mjs';

const file = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
if (!file) {
  console.error('Укажите файл копии: pnpm restore -- data/backups/<файл>.db (список: pnpm backup -- --list)');
  process.exit(1);
}
const port = Number(process.env.PORT ?? 4173);
const serverRunning = await new Promise((done) => {
  const socket = connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
});
if (serverRunning) {
  console.error(`DetailFlow работает на порту ${port}. Остановите сервер перед восстановлением.`);
  process.exit(1);
}
try {
  const result = await restoreDatabaseFile(resolve(file), process.env.DATABASE_PATH ?? resolve('data/detailflow.db'), process.env.BACKUP_DIR ?? resolve('data/backups'));
  console.log(`База восстановлена из ${file}.`);
  if (result.previous) console.log(`Прежняя база сохранена: ${result.previous}`);
} catch (error) {
  console.error(`Восстановление не выполнено: ${error.message}`);
  process.exit(1);
}
