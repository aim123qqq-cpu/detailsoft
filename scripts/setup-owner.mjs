// Usage: pnpm setup:owner -- --center "Название центра" --owner "Имя Фамилия" [--provider telegram|max]
//        pnpm setup:owner -- --tenant <id> --owner "Имя Фамилия"   — новый владелец, если доступ потерян
// Works while the server runs: the invite is redeemed by the running bot.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from '../server/db.mjs';
import { backupDatabaseFile } from '../server/backup.mjs';
import { setupOwner } from '../server/setup.mjs';

const { values } = parseArgs({
  options: { center: { type: 'string' }, tenant: { type: 'string' }, owner: { type: 'string' }, provider: { type: 'string', multiple: true } }
});
const configured = [process.env.TELEGRAM_BOT_TOKEN && 'telegram', process.env.MAX_BOT_TOKEN && 'max'].filter(Boolean);
const providers = values.provider ?? (configured.length ? configured : ['telegram']);

mkdirSync(resolve('data'), { recursive: true });
const databasePath = process.env.DATABASE_PATH ?? resolve('data/detailflow.db');
const backup = await backupDatabaseFile(databasePath, process.env.BACKUP_DIR ?? resolve('data/backups'), {
  reason: 'setup', keep: Number(process.env.BACKUP_KEEP ?? 14)
});
if (backup) console.log(`Копия перед настройкой: ${backup}`);

const db = openDatabase(databasePath, { seed: false });
let result;
try {
  result = setupOwner(db, { centerName: values.center, tenantId: values.tenant, ownerName: values.owner, providers });
} finally {
  db.close();
}
if (result.kind !== 'created') {
  console.error(result.message);
  process.exit(1);
}

// Bot usernames come from the running server; without it the owner sends the code to the bot by hand.
let bots = new Map();
try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 4173}/api/auth/providers`, { signal: AbortSignal.timeout(3000) });
  bots = new Map((await response.json()).items.map((item) => [item.provider, item.botName]));
} catch {}
const links = { telegram: (bot, code) => `https://t.me/${bot}?start=${code}`, max: (bot, code) => `https://max.ru/${bot}?start=${code}` };

console.log(`\nЦентр: ${result.tenant.name} (${result.tenant.id})`);
console.log(`Владелец: ${result.member.displayName}`);
for (const invite of result.invites) {
  const bot = bots.get(invite.provider);
  const title = invite.provider === 'max' ? 'MAX' : 'Telegram';
  console.log(`\n${title}: ${bot ? `откройте ${links[invite.provider](bot, invite.code)} и нажмите «Старт»` : `отправьте боту сообщение ${invite.code}`}`);
}
console.log(`\nПриглашение действует до ${new Date(result.invites[0].expiresAt).toLocaleString('ru-RU')} и срабатывает один раз.`);
console.log('После привязки войдите в DetailFlow через мессенджер. Остальных сотрудников приглашайте из «Профиль → Команда».');
