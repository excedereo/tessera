#!/usr/bin/env bash
# Установка на VPS: sudo bash install.sh [--public]
# --public открывает панель наружу по голому HTTP, без него она слушает только localhost
set -euo pipefail

INSTALL_DIR=/opt/tessera
PORT="${TESSERA_PORT:-8030}"
HOST=127.0.0.1
[ "${1:-}" = "--public" ] && HOST=0.0.0.0

if [ "$(id -u)" -ne 0 ]; then
  echo "Запусти через sudo" >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl >/dev/null

if ! command -v docker >/dev/null; then
  echo "Ставлю Docker"
  curl -4 -fsSL https://get.docker.com | sh
fi

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 20 ]; then
  echo "Ставлю Node.js 22"
  curl -4 -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

mkdir -p "$INSTALL_DIR"
if [ "$SOURCE_DIR" != "$INSTALL_DIR" ]; then
  cp -r "$SOURCE_DIR/server" "$SOURCE_DIR/public" "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$INSTALL_DIR/"
fi
cd "$INSTALL_DIR"
npm ci --omit=dev --no-audit --no-fund --silent

PASSWORD=""
if [ ! -f "$INSTALL_DIR/data/auth.json" ]; then
  PASSWORD="$(openssl rand -base64 18 | tr -d '/+=')"
  TESSERA_DATA="$INSTALL_DIR/data" TESSERA_PASSWORD="$PASSWORD" \
    node --input-type=module -e "import('$INSTALL_DIR/server/store.js').then(s => s.ensurePassword())"
fi

cat > /etc/systemd/system/tessera.service <<UNIT
[Unit]
Description=Tessera
After=docker.service network-online.target
Requires=docker.service

[Service]
WorkingDirectory=$INSTALL_DIR
Environment=TESSERA_HOST=$HOST
Environment=TESSERA_PORT=$PORT
Environment=TESSERA_DATA=$INSTALL_DIR/data
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now tessera
systemctl restart tessera

IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org || echo АДРЕС_СЕРВЕРА)"
echo
echo "Tessera установлена"
if [ "$HOST" = "0.0.0.0" ]; then
  echo "Адрес:  http://$IP:$PORT"
  echo "ВНИМАНИЕ: это HTTP без шифрования, а панель даёт root на сервере"
else
  echo "Панель слушает только localhost. Подключись туннелем со своего компьютера:"
  echo "  ssh -L $PORT:127.0.0.1:$PORT root@$IP"
  echo "и открой http://localhost:$PORT"
fi
[ -n "$PASSWORD" ] && echo "Пароль: $PASSWORD (больше не покажу)"
exit 0
