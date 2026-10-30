#!/usr/bin/env bash
# Move Линза to another domain, e.g. a newly bought one. Run from the repository root:
#   sudo bash deploy/set-domain.sh linza-app.ru
# First point the domain's A record to this server. The script checks DNS, adds the site to
# Caddy, waits for the HTTPS certificate and only then switches the bot and the Mini App to
# the new address. On any error everything stays as it was. The old address keeps working.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;36m→ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✕ %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local v; read -rp "$1${2:+ [$2]}: " v </dev/tty; printf '%s' "${v:-${2:-}}"; }
MARK_END="# --- Линза end ---"

find_caddyfile() {
  local f dir
  f=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$1")
  if [ -z "$f" ]; then
    dir=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$1")
    [ -n "$dir" ] && f="$dir/Caddyfile"
  fi
  printf '%s' "$f"
}
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }

[ "$(id -u)" -eq 0 ] || die "Запустите через sudo: sudo bash deploy/set-domain.sh <домен>"
[ -f .env ] || die "Линза ещё не установлена — сначала: sudo bash deploy/install.sh"
set -a; . ./.env; set +a
MODE=${LINZA_MODE:-caddy}
OLD_URL=${WEBAPP_URL:-}

NEW=${1:-}
[ -n "$NEW" ] || NEW=$(ask "Новый домен, например linza-app.ru")
NEW=${NEW#https://}; NEW=${NEW#http://}; NEW=${NEW%%/*}; NEW=$(printf '%s' "$NEW" | tr '[:upper:]' '[:lower:]')
[[ "$NEW" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "Укажите домен латиницей, например linza-app.ru"
[ "https://$NEW/" != "$OLD_URL" ] || die "Линза уже работает на https://$NEW/"

# Let's Encrypt checks the domain from outside: A must lead here, and a foreign AAAA breaks it.
IP=$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
DNS_IP=$(getent ahostsv4 "$NEW" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)
V6=$(getent ahosts "$NEW" 2>/dev/null | awk '$1 ~ /:/ && $1 !~ /^::ffff:/ { print $1; exit }' || true)
if [ "$DNS_IP" != "$IP" ]; then
  echo
  echo "Сейчас $NEW указывает на ${DNS_IP:-никуда (A-записи нет)}, а IP этого сервера — $IP."
  echo "В DNS домена нужна A-запись: @ → $IP (лишние A-записи для @ удалите)."
  echo "Новая запись начинает работать через 5–30 минут, у только что купленного домена — до нескольких часов."
  [ "$(ask 'Всё равно продолжить? (y/n)' 'n')" = "y" ] || die "Остановлено, ничего не изменено. Повторите, когда DNS обновится."
fi
if [ -n "$V6" ] && ! ip -6 addr 2>/dev/null | grep -qF "$V6"; then
  echo
  echo "У $NEW есть AAAA-запись (IPv6) $V6 — она ведёт не на этот сервер."
  echo "Удалите её в DNS, иначе сертификат может не выпуститься."
  [ "$(ask 'Всё равно продолжить? (y/n)' 'n')" = "y" ] || die "Остановлено, ничего не изменено."
fi

check() { curl -fsS --max-time 5 --resolve "$NEW:443:127.0.0.1" "https://$NEW/api/health" >/dev/null 2>&1; }
wait_https() { local _; for _ in $(seq 1 45); do check && return 0; sleep 4; done; return 1; }

BACKUP=""
restore_proxy() {
  [ -n "$BACKUP" ] || return 0
  cat "$BACKUP" > "$CADDYFILE"
  docker exec "$PROXY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  echo "Caddyfile возвращён как был (копия: $BACKUP)."
}

if [ "$MODE" = proxy ]; then
  # The new site is added next to the existing ones; the app keeps answering on the old address
  # until the new one has a certificate, so the bot never points at a dead URL.
  docker inspect "$PROXY_CONTAINER" >/dev/null 2>&1 || die "Контейнер $PROXY_CONTAINER не найден."
  CADDYFILE=$(find_caddyfile "$PROXY_CONTAINER")
  [ -n "$CADDYFILE" ] && [ -f "$CADDYFILE" ] || die "Не нашёл Caddyfile контейнера $PROXY_CONTAINER."
  PROXY_ENV=$(mktemp)
  trap 'rm -f "$PROXY_ENV"' EXIT
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$PROXY_CONTAINER" > "$PROXY_ENV"
  SITE_MARK="# --- Линза: $NEW ---"
  if grep -qF "$SITE_MARK" "$CADDYFILE"; then
    say "Сайт $NEW уже есть в Caddyfile"
  elif awk -v dom="$NEW" -v envf="$PROXY_ENV" -v mode=find -f deploy/caddy-site.awk "$CADDYFILE"; then
    die "$NEW уже обслуживает другой блок в $CADDYFILE — ничего не изменено."
  else
    BACKUP="$CADDYFILE.bak-linza-$(date +%Y%m%d-%H%M%S)"
    cp -p "$CADDYFILE" "$BACKUP"
    say "Добавляю сайт $NEW в Caddyfile (копия: $BACKUP)"
    {
      [ -z "$(tail -c1 "$CADDYFILE")" ] || echo
      echo
      echo "$SITE_MARK"
      echo "$NEW {"
      echo "	encode zstd gzip"
      echo "	reverse_proxy linza:3000"
      echo "}"
      echo "$MARK_END"
    } >> "$CADDYFILE"
    if ! docker exec "$PROXY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/linza-caddy.log 2>&1; then
      tail -n 8 /tmp/linza-caddy.log
      cat "$BACKUP" > "$CADDYFILE"
      die "Caddy не принял новый конфиг — вернул прежний Caddyfile, ваш прокси не тронут. Пришлите вывод выше."
    fi
  fi
  say "Применяю конфиг Caddy без перезапуска"
  if ! docker exec "$PROXY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/linza-caddy.log 2>&1; then
    tail -n 8 /tmp/linza-caddy.log
    restore_proxy
    die "Caddy не перечитал конфиг. Пришлите вывод выше."
  fi
  say "Жду сертификат для $NEW (до 3 минут)"
  if ! wait_https; then
    restore_proxy
    die "https://$NEW/ не открылся — Линза осталась на прежнем адресе, прокси работает как раньше. Проверьте DNS и пришлите: docker logs --tail 40 $PROXY_CONTAINER"
  fi
fi

say "Переключаю бота и мини-апп на https://$NEW/"
cp -p .env .env.bak-domain
set_env DOMAIN "$NEW"
set_env LINZA_PATH ""
set_env WEBAPP_URL "https://$NEW/"
set_env BOT_WEBHOOK_URL "https://$NEW/bot/webhook"
# On start the app re-registers the webhook and the chat menu button with the new address.
docker compose up -d --force-recreate
if ! wait_https; then
  # Own Caddy (caddy mode) issues the certificate only now; go back if it couldn't.
  cp -p .env.bak-domain .env
  docker compose up -d --force-recreate
  [ "$MODE" = proxy ] && restore_proxy
  die "https://$NEW/ не открылся — вернул прежний адрес $OLD_URL. Проверьте DNS и пришлите: docker compose logs --tail 40"
fi

printf '\n\033[1;32m✓ Линза работает на https://%s/\033[0m\n' "$NEW"
echo "  Бот уже переключён: кнопка «Линза» в чате и вебхук смотрят на новый адрес."
echo "  Админ-панель: https://$NEW/admin/"
echo "  Ссылка t.me/${BOT_USERNAME:-<бот>}/${WEBAPP_SHORT_NAME:-app}: @BotFather → /myapps → бот → Edit Web App URL → https://$NEW/"
if [ "$MODE" = proxy ]; then
  echo "  Старый адрес $OLD_URL продолжает работать — уже отправленные кнопки не сломаются."
fi
