#!/usr/bin/env node
// Lets the DetailFlow server reach the Telegram Bot API when the hosting network cannot (Russian data
// centers): only Telegram goes through the owner's VPN, everything else stays direct.
//   sudo node /opt/detailflow/deploy/telegram-proxy.mjs '<VPN subscription URL>'
// Installs sing-box, turns the subscription (sing-box JSON or vless/vmess/trojan/ss/hysteria2 links)
// into a local proxy on 127.0.0.1:2080 whose routing sends telegram.org/t.me through the VPN and the rest
// direct, tries the VPN servers until api.telegram.org answers, and points DetailFlow's outgoing requests
// at that proxy (systemd drop-in). Secrets stay in /etc/sing-box (root only) and are never printed.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) { console.error('Usage: node telegram-proxy.mjs <subscription URL>'); process.exit(1); }
if (process.getuid?.() !== 0) { console.error('Run as root (sudo).'); process.exit(1); }

const PROXY = 'http://127.0.0.1:2080';
const TELEGRAM = ['telegram.org', 't.me', 'telegram.me', 'telegra.ph', 'telesco.pe'];
const sh = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const quiet = (command, args) => spawnSync(command, args, { encoding: 'utf8' });

// ---- sing-box ----
if (quiet('sing-box', ['version']).status !== 0) {
  console.log('→ installing sing-box');
  sh('bash', ['-c', 'curl -fsSL https://sing-box.app/deb-install.sh | bash']);
}
console.log(`→ ${quiet('sing-box', ['version']).stdout.split('\n')[0]}`);

// ---- subscription → candidate outbounds ----
console.log('→ reading the subscription');
const response = await fetch(url, { headers: { 'user-agent': 'sing-box' } });
if (!response.ok) { console.error(`The subscription answered ${response.status}`); process.exit(1); }
const body = (await response.text()).trim();

const b64 = (value) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const transportOf = (query) => {
  const type = query.get('type');
  if (type === 'ws') return { type: 'ws', path: query.get('path') || '/', ...(query.get('host') ? { headers: { Host: query.get('host') } } : {}) };
  if (type === 'grpc') return { type: 'grpc', service_name: query.get('serviceName') || '' };
  if (type === 'http' || type === 'h2') return { type: 'http', path: query.get('path') || '/', ...(query.get('host') ? { host: [query.get('host')] } : {}) };
  if (type === 'httpupgrade') return { type: 'httpupgrade', path: query.get('path') || '/', ...(query.get('host') ? { host: query.get('host') } : {}) };
  return undefined;
};
const tlsOf = (query, fallbackName) => {
  const security = query.get('security');
  if (security === 'reality') return {
    enabled: true, server_name: query.get('sni') || fallbackName,
    utls: { enabled: true, fingerprint: query.get('fp') || 'chrome' },
    reality: { enabled: true, public_key: query.get('pbk'), short_id: query.get('sid') || '' }
  };
  if (security === 'tls') return {
    enabled: true, server_name: query.get('sni') || fallbackName, insecure: query.get('allowInsecure') === '1',
    ...(query.get('alpn') ? { alpn: query.get('alpn').split(',') } : {}),
    ...(query.get('fp') ? { utls: { enabled: true, fingerprint: query.get('fp') } } : {})
  };
  return undefined;
};
const clean = (object) => JSON.parse(JSON.stringify(object));

function fromLink(link) {
  try {
    if (link.startsWith('vmess://')) {
      const v = JSON.parse(b64(link.slice(8)));
      const query = new URLSearchParams({ type: v.net, path: v.path ?? '', host: v.host ?? '', security: v.tls === 'tls' ? 'tls' : '', sni: v.sni ?? '' });
      return clean({ type: 'vmess', server: v.add, server_port: Number(v.port), uuid: v.id, alter_id: Number(v.aid ?? 0), security: v.scy || 'auto',
        tls: tlsOf(query, v.host || v.add), transport: transportOf(query) });
    }
    if (link.startsWith('ss://')) {
      const rest = link.slice(5).split('#')[0];
      let userinfo, hostport;
      if (rest.includes('@')) [userinfo, hostport] = [rest.slice(0, rest.lastIndexOf('@')), rest.slice(rest.lastIndexOf('@') + 1)];
      else { const decoded = b64(rest); [userinfo, hostport] = [decoded.slice(0, decoded.lastIndexOf('@')), decoded.slice(decoded.lastIndexOf('@') + 1)]; }
      const credentials = userinfo.includes(':') ? decodeURIComponent(userinfo) : b64(decodeURIComponent(userinfo));
      const [method, ...password] = credentials.split(':');
      const [host, port] = [hostport.slice(0, hostport.lastIndexOf(':')), hostport.slice(hostport.lastIndexOf(':') + 1).split(/[/?]/)[0]];
      return { type: 'shadowsocks', server: host.replace(/^\[|\]$/g, ''), server_port: Number(port), method, password: password.join(':') };
    }
    const parsed = new URL(link);
    const query = parsed.searchParams;
    const server = parsed.hostname.replace(/^\[|\]$/g, '');
    const server_port = Number(parsed.port || 443);
    const secret = decodeURIComponent(parsed.username);
    if (parsed.protocol === 'vless:') return clean({ type: 'vless', server, server_port, uuid: secret, flow: query.get('flow') || undefined,
      tls: tlsOf(query, server), transport: transportOf(query), packet_encoding: 'xudp' });
    if (parsed.protocol === 'trojan:') return clean({ type: 'trojan', server, server_port, password: secret,
      tls: tlsOf(query, server) ?? { enabled: true, server_name: query.get('sni') || server }, transport: transportOf(query) });
    if (parsed.protocol === 'hysteria2:' || parsed.protocol === 'hy2:') return clean({ type: 'hysteria2', server, server_port, password: secret,
      tls: { enabled: true, server_name: query.get('sni') || server, insecure: query.get('insecure') === '1' } });
  } catch { /* an unreadable entry is skipped */ }
  return null;
}

let candidates = [];
if (body.startsWith('{')) {
  const skip = new Set(['direct', 'block', 'dns', 'selector', 'urltest']);
  candidates = (JSON.parse(body).outbounds ?? []).filter((outbound) => !skip.has(outbound.type)).map(({ tag, ...rest }) => rest);
} else {
  const text = /^[A-Za-z0-9+/=_\-\s]+$/.test(body) && !body.includes('://') ? b64(body.replace(/\s/g, '')) : body;
  candidates = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(fromLink).filter(Boolean);
}
console.log(`→ VPN servers in the subscription: ${candidates.length} (${[...new Set(candidates.map((item) => item.type))].join(', ') || 'none'})`);
if (!candidates.length) { console.error('No supported VPN servers in the subscription.'); process.exit(1); }

// ---- try them until Telegram answers ----
mkdirSync('/etc/sing-box', { recursive: true });
const configFor = (outbound) => ({
  log: { level: 'warn' },
  inbounds: [{ type: 'mixed', tag: 'local', listen: '127.0.0.1', listen_port: 2080 }],
  outbounds: [{ ...outbound, tag: 'vpn' }, { type: 'direct', tag: 'direct' }],
  route: { rules: [{ domain_suffix: TELEGRAM, outbound: 'vpn' }], final: 'direct', auto_detect_interface: true }
});
let working = null;
for (const [index, outbound] of candidates.slice(0, 15).entries()) {
  const config = configFor(outbound);
  writeFileSync('/etc/sing-box/config.json', JSON.stringify(config, null, 2));
  chmodSync('/etc/sing-box/config.json', 0o600);
  if (quiet('sing-box', ['check', '-c', '/etc/sing-box/config.json']).status !== 0) { console.log(`  ${index + 1}: ${outbound.type} — config not accepted, next`); continue; }
  quiet('systemctl', ['enable', 'sing-box']);
  quiet('systemctl', ['restart', 'sing-box']);
  await new Promise((done) => setTimeout(done, 2500));
  const probe = quiet('curl', ['-sS', '-m', '12', '-o', '/dev/null', '-w', '%{http_code}', '-x', PROXY, 'https://api.telegram.org']);
  const code = probe.stdout.trim();
  console.log(`  ${index + 1}: ${outbound.type} — Telegram ${code && code !== '000' ? `answers (${code})` : 'does not answer'}`);
  if (code && code !== '000') { working = outbound; break; }
}
if (!working) { console.error('None of the VPN servers reached Telegram. Nothing changed in DetailFlow.'); process.exit(1); }

// ---- DetailFlow sends its outgoing requests through the local proxy (only Telegram leaves via the VPN) ----
const dropIn = '/etc/systemd/system/detailflow.service.d';
if (!existsSync(dropIn)) mkdirSync(dropIn, { recursive: true });
writeFileSync(`${dropIn}/telegram-proxy.conf`, `# Written by deploy/telegram-proxy.mjs: outgoing requests go through sing-box on 127.0.0.1:2080,
# which routes only Telegram through the VPN and everything else directly.
[Unit]
Wants=sing-box.service
After=sing-box.service

[Service]
Environment=NODE_USE_ENV_PROXY=1
Environment=HTTPS_PROXY=${PROXY}
Environment=HTTP_PROXY=${PROXY}
Environment=NO_PROXY=localhost,127.0.0.1
`);
sh('systemctl', ['daemon-reload']);
sh('systemctl', ['restart', 'detailflow']);
await new Promise((done) => setTimeout(done, 5000));
const ready = quiet('curl', ['-s', 'http://127.0.0.1:4173/api/ready']).stdout;
console.log(`→ DetailFlow: ${ready}`);
console.log(/"telegram":"ready"/.test(ready) ? '✓ Telegram sign-in works.' : '! Telegram is not ready yet: check the bot token in /opt/detailflow/.env and journalctl -u detailflow -n 30');
