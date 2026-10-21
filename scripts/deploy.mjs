// Runs the server side of DetailFlow from this computer over SSH.
//   node scripts/deploy.mjs setup    first installation on a fresh Ubuntu server (deploy/setup.sh)
//   node scripts/deploy.mjs          update to the latest main and restart (deploy/update.sh)
//   node scripts/deploy.mjs status   service state, readiness and the last log lines
// The server is described in ~/.detailflow/server.json: { "host": "<ip>", "user": "<login>", "domain": "<domain>" }.
// The SSH key is ~/.ssh/detailflow_yc (override with DF_SSH_KEY). Nothing secret is stored in the repository.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const command = process.argv[2] ?? 'update';
const server = JSON.parse(readFileSync(join(homedir(), '.detailflow', 'server.json'), 'utf8'));
const key = process.env.DF_SSH_KEY ?? join(homedir(), '.ssh', 'detailflow_yc');
const target = `${server.user}@${server.host}`;
const sshOptions = ['-i', key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'];
const ssh = (remote) => execFileSync('ssh', [...sshOptions, target, remote], { stdio: 'inherit' });

async function ready() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`https://${server.domain}/api/ready`);
      if (response.ok) return console.log(`✓ https://${server.domain} ${JSON.stringify(await response.json())}`);
    } catch { /* the service is restarting or the certificate is being issued */ }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error(`https://${server.domain}/api/ready did not answer`);
}

if (command === 'setup') {
  execFileSync('scp', [...sshOptions, resolve('deploy', 'setup.sh'), `${target}:/tmp/detailflow-setup.sh`], { stdio: 'inherit' });
  ssh(`bash /tmp/detailflow-setup.sh ${server.domain}`);
  await ready();
} else if (command === 'update') {
  ssh('sudo -u detailflow /opt/detailflow/deploy/update.sh && sudo systemctl restart detailflow');
  await ready();
} else if (command === 'move-data') {
  // The database of this computer moves to the server: a consistent copy (taken while the local server
  // may still run), then the server's database is replaced with it. Bot tokens are moved from the local
  // .env into the server's .env without being shown; the server's own settings stay. Stop the local
  // server first: two servers with one bot token take each other's messages.
  const { backupDatabaseFile } = await import('../server/backup.mjs');
  const copy = await backupDatabaseFile(resolve('data', 'detailflow.db'), resolve('data', 'backups'), { reason: 'move-to-server', keep: 50 });
  if (!copy) throw new Error('There is no local database to move');
  execFileSync('scp', [...sshOptions, copy, `${target}:/tmp/detailflow-move.db`], { stdio: 'inherit' });
  execFileSync('scp', [...sshOptions, resolve('.env'), `${target}:/tmp/detailflow-move.env`], { stdio: 'inherit' });
  ssh([
    'set -e', 'cd /opt/detailflow',
    'sudo systemctl stop detailflow',
    'if [ -f data/detailflow.db ]; then sudo -u detailflow cp data/detailflow.db "data/before-move-$(date +%Y%m%d-%H%M%S).db"; fi',
    'sudo install -o detailflow -g detailflow -m 600 /tmp/detailflow-move.db data/detailflow.db',
    'sudo rm -f data/detailflow.db-wal data/detailflow.db-shm',
    "sudo sed -i '/^TELEGRAM_BOT_TOKEN=/d;/^MAX_BOT_TOKEN=/d' .env",
    "grep -E '^(TELEGRAM_BOT_TOKEN|MAX_BOT_TOKEN)=' /tmp/detailflow-move.env | sudo tee -a .env >/dev/null || true",
    'shred -u /tmp/detailflow-move.env; rm -f /tmp/detailflow-move.db',
    'sudo systemctl start detailflow'
  ].join(' && '));
  await ready();
} else if (command === 'status') {
  ssh('sudo systemctl status detailflow --no-pager -l | head -15; curl -s http://127.0.0.1:4173/api/ready; echo; sudo journalctl -u detailflow -n 20 --no-pager');
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
