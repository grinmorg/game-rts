#!/usr/bin/env bash
# Деплой с рабочей машины без GitHub: rsync исходников на сервер и ops/deploy.sh
# там. Нужны ssh-доступ, rsync и Docker на сервере (DEPLOY.md §1).
#
#   ./ops/push.sh <user>@<server>                   # каталог /var/www/rookfall
#   ./ops/push.sh <user>@<server> /srv/rookfall      # другой каталог
#   DEPLOY_PORT=2222 ./ops/push.sh <user>@<server>  # нестандартный SSH-порт
#
# Уходят исходники и glTF-часть ассет-пака (нужна сборке образа); node_modules,
# dist, data, .git и тяжёлые Blends/FBX/OBJ/PNG из пака — нет. На сервере .env
# и data не трогаются: исключённое rsync не удаляет.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${1:?использование: ops/push.sh <user>@<server> [каталог на сервере]}"
DIR="${2:-/var/www/rookfall}"
SSH=(ssh -p "${DEPLOY_PORT:-22}")

# Версия для /api/health: коммит, с пометкой -dirty, если уезжает незакоммиченное
SHA="$(git rev-parse HEAD 2>/dev/null || echo local)"
if ! git diff --quiet HEAD 2>/dev/null || [[ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]]; then
	SHA="${SHA}-dirty"
fi

echo "→ rsync → ${HOST}:${DIR} (${SHA})"
"${SSH[@]}" "$HOST" "mkdir -p '${DIR}'"
rsync -az --delete --info=stats1 -e "${SSH[*]}" \
	--exclude /.git --exclude /.claude --exclude /data --exclude /.env --exclude /docker-compose.override.yml \
	--exclude node_modules --exclude dist --exclude .DS_Store --exclude '*.log' \
	--exclude 'packages/client/public/models/*.gltf' \
	--exclude 'models/*/Blends' --exclude 'models/*/FBX' --exclude 'models/*/OBJ' --exclude 'models/*/PNG' \
	./ "${HOST}:${DIR}/"

echo "→ Сборка и запуск на сервере"
"${SSH[@]}" "$HOST" "cd '${DIR}' && chmod +x ops/*.sh && GIT_SHA='${SHA}' ./ops/deploy.sh --no-fetch"
