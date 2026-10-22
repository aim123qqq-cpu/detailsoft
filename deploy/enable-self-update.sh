#!/usr/bin/env bash
# One-time switch of a running server to deploys without SSH (the owner chose this on 2026-10-22: the
# VPN on their computer drops SSH). The server updates itself from GitHub every two minutes
# (deploy/self-update.sh), so deploying is just "git push". Run as root from the hosting panel's console:
#   curl -fsSL https://raw.githubusercontent.com/aim123qqq-cpu/detailsoft/main/deploy/enable-self-update.sh | bash
# To switch it off: systemctl disable --now detailflow-update.timer
# It also makes the Telegram proxy (if installed) start with the system and brings DetailFlow up to date.
set -euo pipefail
APP=/opt/detailflow

echo "→ latest code"
sudo -u detailflow git -C "$APP" pull --ff-only --quiet origin main

echo "→ self-update every two minutes"
cat > /etc/systemd/system/detailflow-update.service <<UNIT
[Unit]
Description=DetailFlow: update from GitHub when main has moved
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $APP/deploy/self-update.sh
UNIT
cat > /etc/systemd/system/detailflow-update.timer <<'UNIT'
[Unit]
Description=DetailFlow: check GitHub for a new version every two minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now detailflow-update.timer
if systemctl list-unit-files sing-box.service >/dev/null 2>&1; then systemctl enable --now sing-box >/dev/null 2>&1 || true; fi

echo "→ update and restart DetailFlow"
sudo -u detailflow "$APP/deploy/update.sh" || true
systemctl restart detailflow

echo
echo "self-update: $(systemctl is-active detailflow-update.timer)   sing-box: $(systemctl is-active sing-box 2>/dev/null || echo none)   DetailFlow: $(systemctl is-active detailflow)"
echo "version: $(git -C "$APP" log --oneline -1)"
echo "Done."
