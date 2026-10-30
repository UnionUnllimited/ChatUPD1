#!/usr/bin/env bash
# One-shot setup of Линза on an Ubuntu/Debian server: Docker, HTTPS, the bot webhook
# and (optionally) demo data. Run from the repository root:  sudo bash deploy/install.sh
#
# The mode is picked automatically and saved in .env:
#   caddy — TCP 443 is free: Линза brings its own Caddy for HTTPS.
#   proxy — 443 belongs to an existing Caddy container (e.g. Remnawave): the app joins
#           that container's Docker network and gets its own site block in that
#           Caddyfile (backed up, validated, rolled back on error). Other sites are untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;36m→ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✕ %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local v; read -rp "$1${2:+ [$2]}: " v </dev/tty; printf '%s' "${v:-${2:-}}"; }
MARK="# --- Линза: added by linza/deploy/install.sh ---"

[ "$(id -u)" -eq 0 ] || die "Запустите через sudo: sudo bash deploy/install.sh"

if ! command -v docker >/dev/null 2>&1; then
  say "Устанавливаю Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Нужен Docker Compose v2 (docker compose)."

if [ -f .env ]; then
  say "Нашёл .env — использую его (удалите файл, чтобы ответить на вопросы заново)"
else
  MODE=caddy
  PROXY_CONTAINER=""
  PROXY_NETWORK=""
  if ss -ltnH "( sport = :443 )" 2>/dev/null | grep -q .; then
    holder=$(docker ps --filter publish=443 --format '{{.Names}}|{{.Image}}' 2>/dev/null | head -1 || true)
    name=${holder%%|*}
    image=${holder#*|}
    if [ -n "$holder" ] && [[ "$image" == caddy* ]]; then
      echo
      echo "Порт 443 занят вашим Caddy: контейнер «$name» ($image)."
      echo "Линза подключится к нему: в его Caddyfile добавится отдельный сайт для домена Линзы."
      echo "Перед изменением будет резервная копия, конфиг проверяется, при ошибке всё откатывается."
      echo "Остальные сайты (панель и т. д.) не затрагиваются."
      [ "$(ask 'Продолжить? (y/n)' 'y')" = "y" ] || die "Отменено, ничего не изменено."
      MODE=proxy
      PROXY_CONTAINER=$name
      PROXY_NETWORK=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$name" | grep -vxE 'bridge|host|none|' | head -1 || true)
      [ -n "$PROXY_NETWORK" ] || die "Caddy работает в сети Docker по умолчанию — подключить автоматически не получится. Пришлите вывод: docker inspect $name --format '{{json .NetworkSettings.Networks}}'"
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
  echo "Домен для Линзы — например, поддомен linza.вашдомен.ru с A-записью на $IP."
  DOMAIN=$(ask "Домен (Enter — без своего домена)" "${IP//./-}.sslip.io")
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "Укажите домен без https:// и слешей."
  SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  {
    echo "DOMAIN=$DOMAIN"
    echo "BOT_TOKEN=$BOT_TOKEN"
    echo "BOT_USERNAME=$BOT_USERNAME"
    echo "WEBAPP_SHORT_NAME=app"
    echo "WEBAPP_URL=https://$DOMAIN"
    echo "BOT_WEBHOOK_URL=https://$DOMAIN/bot/webhook"
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
fi
set -a; . ./.env; set +a
MODE=${LINZA_MODE:-caddy}

if [ "$MODE" = proxy ]; then
  docker inspect "$PROXY_CONTAINER" >/dev/null 2>&1 || die "Контейнер $PROXY_CONTAINER не найден."
  CADDYFILE=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$PROXY_CONTAINER")
  if [ -z "$CADDYFILE" ]; then
    dir=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$PROXY_CONTAINER")
    [ -n "$dir" ] && CADDYFILE="$dir/Caddyfile"
  fi
  [ -n "${CADDYFILE:-}" ] && [ -f "$CADDYFILE" ] || die "Не нашёл Caddyfile контейнера $PROXY_CONTAINER. Пришлите вывод: docker inspect $PROXY_CONTAINER --format '{{json .Mounts}}'"
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

if [ "$MODE" = proxy ]; then
  if grep -qF "$MARK" "$CADDYFILE"; then
    say "Сайт Линзы уже есть в $CADDYFILE"
  else
    backup="$CADDYFILE.bak-linza-$(date +%Y%m%d-%H%M%S)"
    cp -p "$CADDYFILE" "$backup"
    say "Добавляю сайт $DOMAIN в Caddyfile (копия: $backup)"
    # Append in place (same inode), so a single-file bind mount keeps working.
    {
      [ -z "$(tail -c1 "$CADDYFILE")" ] || echo
      echo
      echo "$MARK"
      echo "$DOMAIN {"
      echo "	encode zstd gzip"
      echo "	reverse_proxy linza:3000"
      echo "}"
    } >> "$CADDYFILE"
    if ! docker exec "$PROXY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/linza-caddy.log 2>&1; then
      cat "$backup" > "$CADDYFILE"
      tail -n 8 /tmp/linza-caddy.log
      die "Caddy не принял новый конфиг — вернул прежний Caddyfile, ваш прокси не тронут. Пришлите вывод выше."
    fi
  fi
  say "Применяю конфиг Caddy без перезапуска (панель продолжает работать)"
  if ! docker exec "$PROXY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/linza-caddy.log 2>&1; then
    tail -n 8 /tmp/linza-caddy.log
    die "Caddy не перечитал конфиг. Выполните: docker restart $PROXY_CONTAINER — и запустите установку ещё раз."
  fi
fi

say "Жду HTTPS-сертификат для $DOMAIN"
for _ in $(seq 1 40); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    printf '\n\033[1;32m✓ Линза работает: https://%s\033[0m\n' "$DOMAIN"
    echo "  Откройте @$BOT_USERNAME в Telegram, нажмите «Старт» — бот пришлёт кнопку «Открыть Линзу»."
    echo "  Кнопка «Линза» также появится слева от поля ввода (если её нет — перезайдите в чат)."
    echo "  Ссылка t.me/$BOT_USERNAME/app — по желанию: @BotFather → /newapp → short name «app» → URL https://$DOMAIN"
    echo "  Обновление: git pull && sudo docker compose up -d --build"
    exit 0
  fi
  sleep 4
done
if [ "$MODE" = proxy ]; then
  die "Сайт не ответил по HTTPS. Проверьте, что $DOMAIN указывает на этот сервер, и пришлите: docker logs --tail 40 $PROXY_CONTAINER; docker compose logs --tail 40 app"
fi
die "Сайт не ответил по HTTPS. Проверьте, что $DOMAIN указывает на этот сервер, и пришлите: docker compose logs --tail 40 caddy app"
