#!/usr/bin/env bash
# Runs every two minutes on the server (detailflow-update.timer): when main on GitHub has moved,
# builds it (deploy/update.sh, which rolls back on a failed build) and restarts the service.
# Deploying is then just "git push": no SSH from the owner's computer, whose VPN drops SSH.
set -uo pipefail
output=$(sudo -u detailflow /opt/detailflow/deploy/update.sh 2>&1)
status=$?
echo "$output"
if [ $status -eq 0 ] && grep -q '^Updated ' <<<"$output"; then
  systemctl restart detailflow
  echo "Restarted DetailFlow."
fi
exit $status
