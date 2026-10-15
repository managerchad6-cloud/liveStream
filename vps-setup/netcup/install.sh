#!/bin/bash
# One-shot setup for the netcup RS 1000 (Debian 13 trixie).
# Run as root from the extracted app directory:
#   sed -i 's/\r$//' vps-setup/netcup/* && bash vps-setup/netcup/install.sh
set -euo pipefail

APP_DIR=/opt/livestream
APP_USER=livestream
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Run as root"; exit 1; }
[ -f "$APP_DIR/server.js" ] || { echo "App not found in $APP_DIR"; exit 1; }

echo "==> System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  nodejs npm ffmpeg chromium \
  build-essential pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  nginx nftables fail2ban python3-systemd unattended-upgrades \
  curl ca-certificates dos2unix inotify-tools

echo "==> yt-dlp (official binary, apt version goes stale)"
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
# Recent yt-dlp needs a JS runtime for YouTube; node is installed, deno is not
echo "--js-runtimes node" > /etc/yt-dlp.conf

echo "==> 4G swapfile"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10
echo 'vm.swappiness=10' > /etc/sysctl.d/99-livestream.conf

echo "==> Service user"
id "$APP_USER" >/dev/null 2>&1 || \
  useradd --system --create-home --home-dir /var/lib/$APP_USER --shell /usr/sbin/nologin "$APP_USER"

echo "==> .env tweaks for Linux"
if [ -f "$APP_DIR/.env" ]; then
  sed -i 's/\r$//' "$APP_DIR/.env"
  # localhost can resolve to ::1 while the animation server listens on IPv4
  sed -i 's#^ANIMATION_SERVER_URL=.*#ANIMATION_SERVER_URL=http://127.0.0.1:3003#' "$APP_DIR/.env"
  # Drop Windows-only binary paths so platform.js finds /usr/bin/ffmpeg etc.
  sed -i -E '/^(FFMPEG_PATH|FFPROBE_PATH|YTDLP_PATH)=[A-Za-z]:/d' "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
else
  echo "!! $APP_DIR/.env missing - services will start without API keys"
fi

echo "==> npm install"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
runuser -u "$APP_USER" -- bash -c "cd $APP_DIR && npm install --omit=dev"
runuser -u "$APP_USER" -- bash -c "cd $APP_DIR/animation-server && npm install --omit=dev"

echo "==> systemd units"
install -m 644 "$HERE/livestream-api.service" /etc/systemd/system/
install -m 644 "$HERE/livestream-animation.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now livestream-animation livestream-api

echo "==> nginx"
install -m 644 "$HERE/nginx-livestream.conf" /etc/nginx/sites-available/livestream
ln -sf /etc/nginx/sites-available/livestream /etc/nginx/sites-enabled/livestream
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx || systemctl restart nginx

echo "==> Firewall (22, 80, 443 only)"
install -m 644 "$HERE/nftables.conf" /etc/nftables.conf
systemctl enable nftables
systemctl restart nftables

echo "==> fail2ban + unattended-upgrades"
printf '[sshd]\nenabled = true\nbackend = systemd\nmaxretry = 5\nbantime = 1h\n' > /etc/fail2ban/jail.d/sshd.local
systemctl enable fail2ban
systemctl restart fail2ban
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

echo
echo "==> Done. Status:"
systemctl --no-pager --lines=0 status livestream-animation livestream-api nginx | grep -E '●|Active:'
echo "Logs: journalctl -u livestream-animation -f   |   journalctl -u livestream-api -f"
