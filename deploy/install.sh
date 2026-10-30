#!/usr/bin/env bash
# One-shot setup of Линза on a fresh Ubuntu/Debian server:
# Docker, HTTPS via Caddy, the bot webhook and (optionally) demo data.
# Run from the repository root:  sudo bash deploy/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;36m→ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✕ %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local v; read -rp "$1${2:+ [$2]}: " v </dev/tty; printf '%s' "${v:-${2:-}}"; }

[ "$(id -u)" -eq 0 ] || die "Запустите через sudo: sudo bash deploy/install.sh"

if ! command -v docker >/dev/null 2>&1; then
  say "Устанавливаю Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Нужен Docker Compose v2 (docker compose)."

# Caddy needs TCP 443 for HTTPS and the certificate (port 80 is not used).
# On VPN servers 443 is often taken by Xray/Reality or a panel's proxy.
if ss -ltnH "( sport = :443 )" 2>/dev/null | grep -q . && ! docker compose ps --status running 2>/dev/null | grep -q caddy; then
  holder=$(docker ps --filter publish=443 --format '{{.Names}} (образ {{.Image}})' 2>/dev/null | head -1)
  [ -n "$holder" ] || holder=$(ss -ltnpH "( sport = :443 )" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1)
  echo
  echo "Порт 443 занят: ${holder:-неизвестный процесс}."
  echo "Пришлите вывод этих команд — подключу Линзу через уже работающий там прокси:"
  echo "  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'"
  echo "  ss -ltnp | grep -E ':(80|443|8443) '"
  die "Порт 443 занят — установка остановлена, ничего не изменено."
fi

if [ -f .env ]; then
  say "Нашёл .env — использую его (удалите файл, чтобы ответить на вопросы заново)"
else
  IP=$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
  echo "Нужны: токен бота от @BotFather и ваш Telegram ID (его покажет @userinfobot)."
  BOT_TOKEN=$(ask "Токен бота")
  [[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || die "Это не похоже на токен бота."
  BOT_USERNAME=$(curl -fsS --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/getMe" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
  [ -n "$BOT_USERNAME" ] || die "Telegram не принял токен — проверьте его."
  echo "Бот: @$BOT_USERNAME"
  ADMIN_IDS=$(ask "Telegram ID администраторов через запятую")
  [[ "$ADMIN_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "ID — это число, несколько — через запятую."
  DOMAIN=$(ask "Домен, направленный на этот сервер (Enter — без домена)" "${IP//./-}.sslip.io")
  SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  cat > .env <<EOF
DOMAIN=$DOMAIN
BOT_TOKEN=$BOT_TOKEN
BOT_USERNAME=$BOT_USERNAME
WEBAPP_SHORT_NAME=app
WEBAPP_URL=https://$DOMAIN
BOT_WEBHOOK_URL=https://$DOMAIN/bot/webhook
BOT_WEBHOOK_SECRET=$SECRET
BOT_POLLING=0
ADMIN_IDS=$ADMIN_IDS
ALLOW_DEV_AUTH=0
TOP_AUTOPUBLISH_HOUR_MSK=12
EOF
  chmod 600 .env
fi
set -a; . ./.env; set +a

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Открываю порт 443 в ufw"
  ufw allow 443/tcp >/dev/null
fi

say "Собираю приложение"
docker compose build

if [ "$(ask 'Загрузить 25 тестовых VPN для проверки? (y/n)' 'y')" = "y" ]; then
  say "Загружаю тестовые данные (перед настоящим запуском их нужно будет удалить)"
  docker compose run --rm app node --disable-warning=ExperimentalWarning seed/seed.js --reset
fi

say "Запускаю"
docker compose up -d

say "Жду HTTPS-сертификат для $DOMAIN"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    printf '\n\033[1;32m✓ Линза работает: https://%s\033[0m\n' "$DOMAIN"
    echo "  Откройте @$BOT_USERNAME в Telegram и нажмите кнопку «Линза» слева от поля ввода."
    echo "  Для ссылки t.me/$BOT_USERNAME/app: @BotFather → /newapp → short name «app» → URL https://$DOMAIN"
    echo "  Обновление: git pull && sudo docker compose up -d --build"
    exit 0
  fi
  sleep 4
done
die "Сайт не ответил по HTTPS. Проверьте, что $DOMAIN указывает на этот сервер, и посмотрите логи: docker compose logs caddy app"
