#!/usr/bin/env bash
# Деплой Rookfall. Запускается на сервере из каталога проекта — руками, из CI по
# SSH (.github/workflows/ci.yml) или через ops/push.sh с рабочей машины:
#
#   ./ops/deploy.sh              # обновиться до origin/<текущая ветка>
#   ./ops/deploy.sh <sha>        # до конкретного коммита
#   ./ops/deploy.sh --no-fetch   # собрать то, что уже лежит в каталоге
#                                # (так вызывает ops/push.sh после rsync)
#
# Порядок: собрать образ (старый контейнер всё это время обслуживает игру) →
# переключить контейнер → дождаться, что /api/health отвечает новой версией.
# Не дождались — вернуть предыдущий образ: перед сборкой он помечается тегом
# rookfall:previous. Простой — время рестарта контейнера (секунды). Идущие матчи
# при этом рвутся: состояние матча живёт в памяти процесса.
set -euo pipefail
cd "$(dirname "$0")/.."

# ROOKFALL_PORT, PUBLIC_URL, DEPLOY_BRANCH, READY_TIMEOUT — из .env (см. .env.example)
if [[ -f .env ]]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

IMAGE=rookfall
PORT="${ROOKFALL_PORT:-61873}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
READY_TIMEOUT="${READY_TIMEOUT:-90}"

FETCH=1
TARGET=""
for arg in "$@"; do
	case "$arg" in
	--no-fetch) FETCH=0 ;;
	*) TARGET="$arg" ;;
	esac
done

in_git() { git rev-parse --git-dir >/dev/null 2>&1; }
health() { curl -fsS --max-time 5 "$1" 2>/dev/null || true; }

# Ждём, пока /api/health ответит ok и (если задано) именно ожидаемой версией:
# старый контейнер тоже отвечает ok — без сверки версии проверка прошла бы
# ещё до переключения.
wait_ready() { # $1 — ожидаемая версия, "" — любая
	local want="$1" deadline=$((SECONDS + READY_TIMEOUT)) body
	while ((SECONDS < deadline)); do
		body="$(health "$HEALTH_URL")"
		if [[ "$body" == *'"ok":true'* ]] && { [[ -z "$want" ]] || [[ "$body" == *"\"version\":\"${want}\""* ]]; }; then
			return 0
		fi
		sleep 3
	done
	return 1
}

PREVIOUS=""
if in_git; then PREVIOUS="$(git rev-parse HEAD)"; fi

if ((FETCH)); then
	if ! in_git; then
		echo "✗ Каталог не под git: без origin деплой идёт через ops/push.sh с рабочей машины (или ./ops/deploy.sh --no-fetch)" >&2
		exit 1
	fi
	BRANCH="${DEPLOY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
	echo "Текущий коммит: ${PREVIOUS}"
	git fetch origin
	git reset --hard "${TARGET:-origin/${BRANCH}}"
	NEW="$(git rev-parse HEAD)"
else
	# push.sh передаёт версию через GIT_SHA — на сервере может не быть .git
	NEW="${GIT_SHA:-$(git rev-parse HEAD 2>/dev/null || date +%Y%m%d-%H%M%S)}"
fi
echo "Разворачиваем: ${NEW}"

# Предыдущий образ — на случай отката
if docker image inspect "${IMAGE}:latest" >/dev/null 2>&1; then
	docker tag "${IMAGE}:latest" "${IMAGE}:previous"
fi

echo "→ Сборка образа (старая версия пока работает)"
GIT_SHA="${NEW}" docker compose build

echo "→ Переключение контейнера"
docker compose up -d --remove-orphans

echo "→ Ждём /api/health версии ${NEW} (до ${READY_TIMEOUT} с)"
if wait_ready "${NEW}"; then
	echo "✓ Поднялось: $(health "$HEALTH_URL")"
	# Контейнер обновился ≠ сайт обновился: домен может смотреть в другой порт
	# или отдавать статику с диска — тогда деплой «успешен», а игроки видят старое.
	if [[ -n "${PUBLIC_URL:-}" ]]; then
		body="$(health "${PUBLIC_URL%/}/api/health")"
		if [[ "$body" == *"\"version\":\"${NEW}\""* ]]; then
			echo "✓ ${PUBLIC_URL} отдаёт ${NEW}"
		else
			echo "‼ ${PUBLIC_URL%/}/api/health отдаёт не эту версию: '${body:-нет ответа}'" >&2
			echo "  Домен должен проксироваться на 127.0.0.1:${PORT} (ops/nginx/rookfall.conf):" >&2
			echo "  grep -rn 'proxy_pass\\|root' /etc/nginx/sites-enabled/" >&2
			exit 1
		fi
	else
		echo "· PUBLIC_URL не задан в .env — снаружи не проверяли"
	fi
	docker image prune -f >/dev/null # старые слои; rookfall:previous с тегом — остаётся
	docker compose ps
	exit 0
fi

echo "✗ Новая версия не поднялась. Хвост лога:" >&2
docker compose logs --tail 80 rookfall >&2
if docker image inspect "${IMAGE}:previous" >/dev/null 2>&1; then
	echo "↩ Откат на предыдущий образ" >&2
	docker tag "${IMAGE}:previous" "${IMAGE}:latest"
	docker compose up -d --no-build --force-recreate
	if ((FETCH)) && [[ -n "$PREVIOUS" ]]; then git reset --hard "$PREVIOUS"; fi
	if wait_ready ""; then
		echo "↩ Откат выполнен, работает предыдущая версия: $(health "$HEALTH_URL")" >&2
	else
		echo "‼ Откат тоже не поднялся — нужен ручной разбор: docker compose logs rookfall" >&2
	fi
else
	echo "‼ Предыдущего образа нет (первый деплой) — откатывать нечего" >&2
fi
exit 1
