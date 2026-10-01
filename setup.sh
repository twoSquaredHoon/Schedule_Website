#!/usr/bin/env bash
# One-time setup for Schedule on Linux Mint.
# Put Schedule_Website and Schedule_App side by side (e.g. ~/Schedule_Website and ~/Schedule_App),
# then run:  bash ~/Schedule_Website/setup.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ ! -d "$HERE/../Schedule_App" ]; then
  echo "Put the Schedule_App folder next to Schedule_Website, then run this again." >&2
  exit 1
fi
APP="$(cd "$HERE/../Schedule_App" && pwd)"
DATA="${SCHEDULE_DATA:-$HOME/schedule-data}"
PORT="${PORT:-3000}"

echo "== Installing ffmpeg, sqlite3, curl"
sudo apt-get update -y
sudo apt-get install -y ffmpeg sqlite3 curl

echo "== Checking Node.js (needs 22.13 or newer)"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

echo "== Installing server packages"
cd "$HERE"
npm ci --omit=dev

echo "== Data folder: $DATA"
mkdir -p "$DATA/memes" "$DATA/backups"

echo "== Starting Schedule as a service (starts on boot, restarts if it crashes)"
sudo tee /etc/systemd/system/schedule.service >/dev/null <<EOF
[Unit]
Description=Schedule (life log server)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$HERE
Environment=PORT=$PORT
Environment=SCHEDULE_DATA=$DATA
Environment=SCHEDULE_APP_DIR=$APP
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now schedule
sudo systemctl restart schedule

echo "== Keeping the laptop awake, even with the lid closed"
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/; s/^#\?HandleLidSwitchDocked=.*/HandleLidSwitchDocked=ignore/' /etc/systemd/logind.conf
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
echo "   (restart once later so the lid setting takes effect)"

echo "== Nightly database backup at 4am (keeps 14 days)"
LINE="0 4 * * * sqlite3 '$DATA/schedule.db' \".backup '$DATA/backups/schedule-\$(date +\\%F).db'\" && find '$DATA/backups' -name 'schedule-*.db' -mtime +14 -delete"
( crontab -l 2>/dev/null | grep -v 'schedule.db' ; echo "$LINE" ) | crontab -

echo "== Tailscale (private link from your phone)"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
sudo tailscale up || true
sudo tailscale serve --bg "$PORT" || echo "   If this failed, turn on HTTPS in the Tailscale admin page (DNS > HTTPS Certificates) and run: sudo tailscale serve --bg $PORT"

echo
echo "Done. Your links:"
tailscale serve status 2>/dev/null || true
echo "   Phone app:  <link above>/app/"
echo "   Website:    <link above>/"
echo "Check it's running:  systemctl status schedule"
