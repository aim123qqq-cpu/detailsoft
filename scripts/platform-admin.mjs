// Who may open detailflow.ru/admin: the messenger accounts of the DetailFlow service owner.
// Run on the server, in /opt/detailflow, as root or the service user:
//   node scripts/platform-admin.mjs            the messenger accounts linked to centers, and the current admins
//   node scripts/platform-admin.mjs add telegram 123456789
//   node scripts/platform-admin.mjs remove telegram 123456789
// Shows account ids and messenger names only; no customer data.
import { resolve } from 'node:path';
import { openDatabase } from '../server/db.mjs';

const db = openDatabase(process.env.DATABASE_PATH ?? resolve('data/detailflow.db'), { seed: false });
const [command, provider, id] = process.argv.slice(2);

if (command === 'add' || command === 'remove') {
  if (!['telegram', 'max'].includes(provider) || !/^\d+$/.test(id ?? '')) {
    console.error('Usage: node scripts/platform-admin.mjs add|remove telegram|max <account id>');
    process.exit(1);
  }
  if (command === 'add') db.prepare('INSERT OR IGNORE INTO platform_admins (provider, external_user_id) VALUES (?, ?)').run(provider, id);
  else db.prepare('DELETE FROM platform_admins WHERE provider = ? AND external_user_id = ?').run(provider, id);
}

const accounts = db.prepare(`SELECT l.provider, l.external_user_id AS id, MAX(l.external_name) AS name, GROUP_CONCAT(t.name, ', ') AS centers
  FROM member_messenger_links l JOIN tenants t ON t.id = l.tenant_id GROUP BY l.provider, l.external_user_id`).all();
const admins = db.prepare('SELECT provider, external_user_id AS id FROM platform_admins').all();
console.log('Messenger accounts linked to centers:');
for (const account of accounts) console.log(`  ${account.provider} ${account.id}  ${account.name ?? ''}  (${account.centers})`);
console.log(admins.length ? `Admins: ${admins.map((admin) => `${admin.provider} ${admin.id}`).join(', ')}` : 'Admins: none yet');
db.close();
