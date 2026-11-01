#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu/Debian VPS (run as root from the repo checkout).
# Installs Docker if needed, opens the firewall, starts the game with HTTPS and
# turns on automatic updates from GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
ENV_FILE="$REPO_DIR/deploy/.env"
RTC_PORT="${RTC_PORT:-40000}"

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

# Public IPv4: Hetzner metadata, then a generic lookup.
IP="$(curl -fsS --max-time 3 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 2>/dev/null || true)"
[ -n "$IP" ] || IP="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
[ -n "$IP" ] || { echo "Could not determine the public IP"; exit 1; }

if [ ! -f "$ENV_FILE" ]; then
  # Free hostname that points at this IP, so HTTPS works without buying a domain.
  # Put your own domain here later if you like (and point its DNS at $IP).
  DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"
  {
    echo "DOMAIN=$DOMAIN"
    echo "RTC_PORT=$RTC_PORT"
    # Only needed if the server's network card doesn't carry the public IP (1:1 NAT).
    if ! ip -4 addr | grep -q " $IP/"; then echo "RTC_PUBLIC_IP=$IP"; fi
  } > "$ENV_FILE"
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

# Firewall: SSH, HTTP(S), and the WebRTC UDP port.
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw allow "${RTC_PORT}/udp"
  ufw --force enable
fi

docker compose -f deploy/docker-compose.yml --env-file "$ENV_FILE" up -d --build

# Auto-update: check GitHub every 5 minutes and redeploy when something changed.
chmod +x deploy/update.sh
echo "*/5 * * * * root $REPO_DIR/deploy/update.sh >> /var/log/curve-royale-update.log 2>&1" > /etc/cron.d/curve-royale

echo
echo "Curve Royale is starting at: https://$DOMAIN"
echo "(the HTTPS certificate can take a minute on the first visit)"
