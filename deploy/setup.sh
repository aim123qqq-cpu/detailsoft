#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for DetailFlow (Yandex Cloud VM or any VPS).
# Run as the login user with sudo:   curl -fsSL <raw url of this file> | bash -s -- crm.example.ru
# or, from a copy:                    bash setup.sh crm.example.ru
# Installs Node.js 24, pnpm, git and Caddy (HTTPS); creates the "detailflow" service user; clones the
# repository to /opt/detailflow; builds it; starts the service behind Caddy. Safe to run again.
set -euo pipefail

DOMAIN="${1:?usage: setup.sh <domain>}"
REPO="${DF_REPO:-https://github.com/aim123qqq-cpu/detailsoft.git}"
APP=/opt/detailflow
SERVICE_USER=detailflow

echo "→ system packages"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git gnupg ufw debian-keyring debian-archive-keyring apt-transport-https sqlite3

echo "→ Node.js 24"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable

echo "→ Caddy (HTTPS certificates are obtained and renewed automatically)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

echo "→ service user and code in $APP"
id "$SERVICE_USER" >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir "/home/$SERVICE_USER" --shell /usr/sbin/nologin "$SERVICE_USER"
if [ ! -d "$APP/.git" ]; then
  sudo mkdir -p "$APP"
  sudo chown "$SERVICE_USER:$SERVICE_USER" "$APP"
  sudo -u "$SERVICE_USER" git clone "$REPO" "$APP"
fi
if [ ! -f "$APP/.env" ]; then
  # Production defaults; bot tokens are added later (never through git or chat).
  sudo -u "$SERVICE_USER" tee "$APP/.env" >/dev/null <<'ENV'
HOST=127.0.0.1
PORT=4173
DEMO_AUTH=false
SEED_DEMO=false
BACKUP_INTERVAL_HOURS=6
BACKUP_KEEP=28
ENV
fi
sudo chmod 600 "$APP/.env"

echo "→ build"
sudo -u "$SERVICE_USER" bash -c "cd '$APP' && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile && corepack pnpm build"

echo "→ systemd service"
sudo tee /etc/systemd/system/detailflow.service >/dev/null <<UNIT
[Unit]
Description=DetailFlow
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$APP
ExecStart=/usr/bin/node --env-file-if-exists=.env server/index.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$APP/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo -u "$SERVICE_USER" mkdir -p "$APP/data"
sudo systemctl daemon-reload
sudo systemctl enable --now detailflow

echo "→ Caddy for $DOMAIN"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4173
}

www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
CADDY
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "→ firewall: SSH, HTTP, HTTPS"
sudo ufw allow OpenSSH >/dev/null
sudo ufw allow 80/tcp >/dev/null
sudo ufw allow 443/tcp >/dev/null
sudo ufw --force enable >/dev/null

# Lets the login user run the update script and restart the service without a password prompt.
sudo tee /etc/sudoers.d/detailflow >/dev/null <<SUDO
$(whoami) ALL=($SERVICE_USER) NOPASSWD: $APP/deploy/update.sh
$(whoami) ALL=(root) NOPASSWD: /usr/bin/systemctl restart detailflow, /usr/bin/systemctl status detailflow, /usr/bin/journalctl -u detailflow *
SUDO
sudo chmod 440 /etc/sudoers.d/detailflow

echo "→ check"
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4173/api/ready >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:4173/api/ready && echo
echo "Done. Open https://$DOMAIN once the domain's A record points to this server."
