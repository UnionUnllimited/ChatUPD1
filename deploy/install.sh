#!/usr/bin/env bash
# One-shot setup of Линза on an Ubuntu/Debian server: Docker, HTTPS, the bot webhook
# and (optionally) demo data. Run from the repository root:  sudo bash deploy/install.sh
#
# The mode is picked automatically and saved in .env:
#   caddy — TCP 443 is free: Линза brings its own Caddy for HTTPS.
#   proxy — 443 belongs to an existing Caddy container (e.g. Remnawave): the app joins
#           that container's Docker network as "linza" and the Caddyfile gets either
#           a separate site for a new domain, or a path (e.g. /linza) inside the block
#           of a domain that already serves something else. The Caddyfile is backed up,
#           validated and rolled back on any error; other sites are untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;36m→ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✕ %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local v; read -rp "$1${2:+ [$2]}: " v </dev/tty; printf '%s' "${v:-${2:-}}"; }
MARK="# --- Линза: added by linza/deploy/install.sh ---"
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
# Is there already a site block for this domain in the proxy's Caddyfile?
site_exists() { awk -v dom="$1" -v envf="$PROXY_ENV" -v mode=find -f deploy/caddy-site.awk "$CADDYFILE"; }

[ "$(id -u)" -eq 0 ] || die "Запустите через sudo: sudo bash deploy/install.sh"

if ! command -v docker >/dev/null 2>&1; then
  say "Устанавливаю Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Нужен Docker Compose v2 (docker compose)."
PROXY_ENV=$(mktemp)
trap 'rm -f "$PROXY_ENV"' EXIT

if [ -f .env ]; then
  say "Нашёл .env — использую его (удалите файл, чтобы ответить на вопросы заново)"
  set -a; . ./.env; set +a
else
  MODE=caddy
  PROXY_CONTAINER=""
  PROXY_NETWORK=""
  LINZA_PATH=""
  if ss -ltnH "( sport = :443 )" 2>/dev/null | grep -q .; then
    holder=$(docker ps --filter publish=443 --format '{{.Names}}|{{.Image}}' 2>/dev/null | head -1 || true)
    name=${holder%%|*}
    image=${holder#*|}
    if [ -n "$holder" ] && [[ "$image" == caddy* ]]; then
      echo
      echo "Порт 443 занят вашим Caddy: контейнер «$name» ($image)."
      echo "Линза подключится к нему. Перед изменением Caddyfile будет резервная копия,"
      echo "конфиг проверяется, при любой ошибке всё откатывается. Остальные сайты не затрагиваются."
      [ "$(ask 'Продолжить? (y/n)' 'y')" = "y" ] || die "Отменено, ничего не изменено."
      MODE=proxy
      PROXY_CONTAINER=$name
      PROXY_NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$name" | grep -vxE 'bridge|host|none|' | head -1 || true)
      [ -n "$PROXY_NETWORK" ] || die "Caddy работает в сети Docker по умолчанию — подключить автоматически не получится. Пришлите вывод: docker inspect $name --format '{{json .NetworkSettings.Networks}}'"
      CADDYFILE=$(find_caddyfile "$name")
      [ -n "$CADDYFILE" ] && [ -f "$CADDYFILE" ] || die "Не нашёл Caddyfile контейнера $name. Пришлите вывод: docker inspect $name --format '{{json .Mounts}}'"
      docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" > "$PROXY_ENV"
    else
      [ -n "$holder" ] || holder=$(ss -ltnpH "( sport = :443 )" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1 || true)
      echo
      echo "Порт 443 занят: ${holder:-неизвестный процесс}."
      echo "Пришлите вывод этих команд — подключу Линзу через уже работающий там прокси:"
      echo "  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'"
      echo "  ss -ltnp | grep -E ':(80|443|8443) '"
      die "Порт 443 занят — установка остановлена, ничего не изменено."
    fi
  fi

  IP=$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
  echo
  echo "Нужны: токен бота от @BotFather и ваш Telegram ID (его покажет @userinfobot)."
  BOT_TOKEN=$(ask "Токен бота")
  [[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || die "Это не похоже на токен бота."
  BOT_USERNAME=$(curl -fsS --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/getMe" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p' || true)
  [ -n "$BOT_USERNAME" ] || die "Telegram не принял токен — проверьте его."
  echo "Бот: @$BOT_USERNAME"
  ADMIN_IDS=$(ask "Telegram ID администраторов через запятую")
  [[ "$ADMIN_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "ID — это число, несколько — через запятую."
  echo
  echo "Домен для Линзы: свой поддомен с A-записью на $IP или домен, который уже открывается"
  echo "через ваш Caddy (тогда Линза встанет на нём по отдельному пути)."
  DOMAIN=$(ask "Домен (Enter — без своего домена)" "${IP//./-}.sslip.io")
  DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN%%/*}
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "Укажите домен, например linza.example.com"
  if [ "$MODE" = proxy ] && site_exists "$DOMAIN"; then
    echo
    echo "$DOMAIN уже обслуживается вашим Caddy — Линза встанет на нём по отдельному пути,"
    echo "всё, что открывается на этом домене сейчас, продолжит работать как раньше."
    LINZA_PATH=$(ask "Путь" "/linza")
    LINZA_PATH="/${LINZA_PATH#/}"; LINZA_PATH=${LINZA_PATH%/}
    [[ "$LINZA_PATH" =~ ^/[a-z0-9][a-z0-9-]*$ ]] || die "Путь — латиница, цифры и дефис, например /linza"
  else
    # A new site needs the domain's A record to point here, or no certificate is issued.
    DNS_IP=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)
    if [ "$DNS_IP" != "$IP" ]; then
      echo
      echo "Внимание: $DOMAIN указывает на ${DNS_IP:-никуда (нет A-записи)}, а IP этого сервера — $IP."
      echo "Сертификат не выпустится, пока A-запись не ведёт сюда. Если домен обслуживается другим"
      echo "сервером (например, через frp), Линзу нужно подключать там или взять другой домен."
      [ "$(ask 'Всё равно продолжить? (y/n)' 'n')" = "y" ] || die "Остановлено, ничего не изменено."
    fi
  fi
  SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  {
    echo "DOMAIN=$DOMAIN"
    echo "LINZA_PATH=$LINZA_PATH"
    echo "BOT_TOKEN=$BOT_TOKEN"
    echo "BOT_USERNAME=$BOT_USERNAME"
    echo "WEBAPP_SHORT_NAME=app"
    echo "WEBAPP_URL=https://$DOMAIN$LINZA_PATH/"
    echo "BOT_WEBHOOK_URL=https://$DOMAIN$LINZA_PATH/bot/webhook"
    echo "BOT_WEBHOOK_SECRET=$SECRET"
    echo "BOT_POLLING=0"
    echo "ADMIN_IDS=$ADMIN_IDS"
    echo "ALLOW_DEV_AUTH=0"
    echo "TOP_AUTOPUBLISH_HOUR_MSK=12"
    echo "LINZA_MODE=$MODE"
    if [ "$MODE" = proxy ]; then
      echo "COMPOSE_FILE=docker-compose.yml:deploy/compose.proxy.yml"
      echo "PROXY_CONTAINER=$PROXY_CONTAINER"
      echo "PROXY_NETWORK=$PROXY_NETWORK"
    else
      echo "COMPOSE_PROFILES=caddy"
    fi
  } > .env
  chmod 600 .env
  set -a; . ./.env; set +a
fi
MODE=${LINZA_MODE:-caddy}
LINZA_PATH=${LINZA_PATH:-}

if [ "$MODE" = proxy ]; then
  docker inspect "$PROXY_CONTAINER" >/dev/null 2>&1 || die "Контейнер $PROXY_CONTAINER не найден."
  CADDYFILE=$(find_caddyfile "$PROXY_CONTAINER")
  [ -n "$CADDYFILE" ] && [ -f "$CADDYFILE" ] || die "Не нашёл Caddyfile контейнера $PROXY_CONTAINER."
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$PROXY_CONTAINER" > "$PROXY_ENV"
  echo "Caddyfile вашего прокси: $CADDYFILE"
elif command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Открываю порт 443 в ufw"
  ufw allow 443/tcp >/dev/null
fi

say "Собираю приложение"
docker compose build app

if [ "$(ask 'Загрузить 25 тестовых VPN для проверки? (y/n)' 'y')" = "y" ]; then
  say "Загружаю тестовые данные (перед настоящим запуском их нужно будет удалить)"
  docker compose run --rm app node --disable-warning=ExperimentalWarning seed/seed.js --reset
fi

say "Запускаю"
docker compose up -d

BACKUP=""
restore_proxy() {
  [ -n "$BACKUP" ] || return 0
  cat "$BACKUP" > "$CADDYFILE"
  docker exec "$PROXY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  echo "Caddyfile возвращён как был (копия: $BACKUP)."
}

if [ "$MODE" = proxy ]; then
  if grep -qF "$MARK" "$CADDYFILE"; then
    say "Линза уже прописана в $CADDYFILE"
  else
    BACKUP="$CADDYFILE.bak-linza-$(date +%Y%m%d-%H%M%S)"
    cp -p "$CADDYFILE" "$BACKUP"
    patched=$(mktemp)
    if [ -n "$LINZA_PATH" ]; then
      say "Добавляю путь $LINZA_PATH в блок сайта $DOMAIN (копия: $BACKUP)"
      snip=$(mktemp)
      printf '\t%s\n\tredir %s %s/ 308\n\thandle_path %s/* {\n\t\treverse_proxy linza:3000\n\t}\n\t%s\n' \
        "$MARK" "$LINZA_PATH" "$LINZA_PATH" "$LINZA_PATH" "$MARK_END" > "$snip"
      awk -v dom="$DOMAIN" -v envf="$PROXY_ENV" -v mode=insert -v snip="$snip" -f deploy/caddy-site.awk "$CADDYFILE" > "$patched" \
        || { rm -f "$snip" "$patched"; die "Не нашёл блок сайта $DOMAIN в $CADDYFILE — ничего не изменено."; }
      rm -f "$snip"
    else
      say "Добавляю сайт $DOMAIN в Caddyfile (копия: $BACKUP)"
      cat "$CADDYFILE" > "$patched"
      {
        [ -z "$(tail -c1 "$CADDYFILE")" ] || echo
        echo
        echo "$MARK"
        echo "$DOMAIN {"
        echo "	encode zstd gzip"
        echo "	reverse_proxy linza:3000"
        echo "}"
        echo "$MARK_END"
      } >> "$patched"
    fi
    # Write in place (same inode), so a single-file bind mount keeps working.
    cat "$patched" > "$CADDYFILE"
    rm -f "$patched"
    if ! docker exec "$PROXY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/linza-caddy.log 2>&1; then
      tail -n 8 /tmp/linza-caddy.log
      cat "$BACKUP" > "$CADDYFILE"
      die "Caddy не принял новый конфиг — вернул прежний Caddyfile, ваш прокси не тронут. Пришлите вывод выше."
    fi
  fi
  say "Применяю конфиг Caddy без перезапуска (остальные сайты продолжают работать)"
  if ! docker exec "$PROXY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/linza-caddy.log 2>&1; then
    tail -n 8 /tmp/linza-caddy.log
    restore_proxy
    die "Caddy не перечитал конфиг. Пришлите вывод выше."
  fi
fi

APP_URL="https://$DOMAIN$LINZA_PATH/"
CHECK=(curl -fsS --max-time 5)
# Through an existing proxy, check it directly — independent of DNS and hairpin NAT.
[ "$MODE" = proxy ] && CHECK+=(--resolve "$DOMAIN:443:127.0.0.1")
say "Проверяю $APP_URL"
for _ in $(seq 1 40); do
  if "${CHECK[@]}" "${APP_URL}api/health" >/dev/null 2>&1; then
    printf '\n\033[1;32m✓ Линза работает: %s\033[0m\n' "$APP_URL"
    echo "  Откройте @$BOT_USERNAME в Telegram, нажмите «Старт» — бот пришлёт кнопку «Открыть Линзу»."
    echo "  Кнопка «Линза» также появится слева от поля ввода (если её нет — перезайдите в чат)."
    echo "  Ссылка t.me/$BOT_USERNAME/app — по желанию: @BotFather → /newapp → short name «app» → URL $APP_URL"
    echo "  Обновление: git pull && sudo docker compose up -d --build"
    exit 0
  fi
  sleep 4
done
if [ "$MODE" = proxy ]; then
  restore_proxy
  die "По адресу $APP_URL Линза не ответила — изменения в Caddy откатил, ваш прокси работает как раньше. Пришлите: docker logs --tail 40 $PROXY_CONTAINER; docker compose logs --tail 40 app"
fi
die "Сайт не ответил по HTTPS. Проверьте, что $DOMAIN указывает на этот сервер, и пришлите: docker compose logs --tail 40 caddy app"
