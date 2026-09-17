# Деплой Rookfall

Игра — один Node-процесс: раздаёт собранный клиент, `/api/*` и lockstep-WebSocket
`/ws` на одном порту. В проде он живёт в одном контейнере docker compose, наружу
смотрит один хост-порт **61873** на 127.0.0.1, TLS терминирует nginx на хосте.
Ни базы, ни Redis нет; единственное состояние — реплеи матчей в volume.

Файлы деплоя:

| Файл | Что |
|---|---|
| [Dockerfile](Dockerfile) | сборка клиента и сервера, копирование glTF-моделей из ассет-пака, процесс под `node`, healthcheck |
| [docker-compose.yml](docker-compose.yml) | сервис `rookfall`, порт из `.env`, volume реплеев, лимит памяти, ротация логов |
| [.env.example](.env.example) | `ROOKFALL_PORT`, `ROOKFALL_BIND`, `PUBLIC_URL` — на сервере копируется в `.env` |
| [ops/deploy.sh](ops/deploy.sh) | обновление на сервере: сборка → переключение → проверка версии → откат при неудаче |
| [ops/push.sh](ops/push.sh) | деплой с рабочей машины без GitHub: rsync + `deploy.sh` по ssh |
| [ops/nginx/rookfall.conf](ops/nginx/rookfall.conf) | vhost хостового nginx: прокси `/` и `/ws`, gzip |
| [ops/ecosystem.config.cjs](ops/ecosystem.config.cjs) | вариант без Docker — PM2 |

## Порты

Проект рассчитан на общий VPS, где уже живут BlindKit, Poker Kit и Poker TG
Client. Их порты — 3000…3202 плюс 5432/6379: диапазон 3xxx занят «по образцу»,
и следующий сосед с большой вероятностью возьмёт 3300. Rookfall берёт порт из
другой области:

|            | BlindKit               | Poker Kit            | Poker TG Client            | **Rookfall**           |
| ---------- | ---------------------- | -------------------- | -------------------------- | --------------------- |
| Каталог    | `/var/www/blind-kit`   | `/var/www/poker-kit` | `/var/www/poker-tg-client` | `/var/www/rookfall`    |
| Runtime    | PM2                    | PM2                  | docker compose             | docker compose        |
| Хост-порты | 3000, 3001, 5432, 6379 | 3100, 3101           | 3200, 3201, 3202           | **61873** (127.0.0.1) |

Почему 61873:

- вне 3xxx/5xxx/6xxx/8xxx/9xxx, где сидят соседи и дефолты популярных сервисов
  (3000, 5432, 6379, 8080, 8443, 9000, 9090…);
- выше эфемерного диапазона Linux (32768–60999): случайное исходящее соединение
  никогда не займёт этот порт первым, и `bind` не упадёт с `EADDRINUSE`;
- известных сервисов на нём нет; ближайшие занятые в этой области — 61613/61616
  (ActiveMQ), 62078 (Apple), 64738 (Mumble) — далеко.

Тот же номер используется и внутри контейнера, чтобы в логах, compose-файле,
nginx и PM2 фигурировало одно число. Диапазон **61870–61879** считаем
закреплённым за проектом — на случай второго инстанса или метрик. Если порт
всё же занят, он меняется одной строкой `ROOKFALL_PORT` в `.env` (и в
`proxy_pass` nginx), пересобирать ничего не надо.

Проверить занятость перед первым запуском:

```bash
ss -ltnp | grep -E ':6187[0-9]\b' || echo "6187x свободны"
```

## 1. Первичная настройка сервера (один раз)

Нужны: Docker с Compose v2 (`docker compose version`), nginx на хосте, DNS
A-запись домена → IP сервера. На общем VPS всё это уже есть; на чистом
Ubuntu/Debian:

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
usermod -aG docker <user>          # деплоить без sudo; перелогиниться
apt install -y nginx certbot python3-certbot-nginx rsync
```

### Код на сервере и первый запуск

Каталог создаёт root, дальше всё делается от обычного пользователя:

```bash
ssh <user>@<server>
sudo mkdir -p /var/www/rookfall && sudo chown "$USER" /var/www/rookfall
```

**Вариант А — из git** (репозиторий выложен на GitHub):

```bash
git clone <git-url> /var/www/rookfall
cd /var/www/rookfall
cp .env.example .env                        # порт и PUBLIC_URL — комментарии внутри
docker compose up -d --build                # первая сборка 3–5 минут
curl -s http://127.0.0.1:61873/api/health   # {"ok":true,"version":"dev","rooms":0,"clients":0}
```

**Вариант Б — без GitHub**, с рабочей машины (у репозитория пока нет remote —
это текущий случай):

```bash
./ops/push.sh <user>@<server>               # rsync исходников + сборка + запуск
ssh <user>@<server> 'cd /var/www/rookfall && cp -n .env.example .env'
```

`push.sh` отправляет исходники и glTF-часть ассет-пака (нужна сборке образа),
пропуская `node_modules`, `dist`, `data`, `.git` и тяжёлые Blends/FBX/OBJ/PNG,
после чего запускает на сервере `ops/deploy.sh --no-fetch`. Версия в
`/api/health` — sha текущего коммита, с суффиксом `-dirty`, если уехало
незакоммиченное. `.env` и `data` на сервере не трогаются.

Без `.env` работают значения по умолчанию (127.0.0.1:61873); `PUBLIC_URL`
нужен только для внешней проверки после деплоя (§2).

### nginx на хосте и TLS

```bash
cd /var/www/rookfall
sudo cp ops/nginx/rookfall.conf /etc/nginx/sites-available/rookfall
sudo sed -i 's/rookfall.example.com/<домен>/' /etc/nginx/sites-available/rookfall
sudo ln -s /etc/nginx/sites-available/rookfall /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <домен>             # сертификат + редирект 80→443
```

Конфиг проксирует `/` и `/ws` на `127.0.0.1:61873`; для `/ws` включён апгрейд
соединения и таймаут в час — матч живёт десятки минут. gzip включён на стороне
nginx: Node ничего не сжимает, а бандл three.js и glTF (JSON с base64, ~12 МБ)
ужимаются в разы.

После этого в `.env` задать `PUBLIC_URL=https://<домен>` — по нему
`deploy.sh` будет проверять, что наружу уходит развёрнутый коммит.

## 2. Обновление

### На сервере — `ops/deploy.sh`

```bash
cd /var/www/rookfall
./ops/deploy.sh              # до origin/<текущая ветка>, с проверкой и откатом
./ops/deploy.sh <sha>        # до конкретного коммита
```

Что делает:

1. `git fetch` и `reset --hard` на целевой коммит (пропускается с `--no-fetch`);
2. помечает работающий образ тегом `rookfall:previous`;
3. собирает новый образ с `GIT_SHA=<коммит>` — старый контейнер в это время
   обслуживает игру;
4. переключает контейнер (`docker compose up -d`) — простой несколько секунд;
5. до 90 с ждёт, пока `/api/health` не ответит `"ok":true` **с новой версией**:
   старый контейнер тоже отвечает `ok`, без сверки версии проверка прошла бы
   до переключения;
6. если задан `PUBLIC_URL`, повторяет проверку через домен — контейнер мог
   обновиться, а nginx смотреть в другой порт или отдавать статику с диска;
7. не дождался — возвращает `rookfall:previous`, печатает хвост лога и
   завершается с ошибкой.

Идущие матчи при переключении рвутся: состояние матча живёт в памяти
процесса, клиенты получат обрыв WebSocket. Деплоить лучше, когда
`curl -s 127.0.0.1:61873/api/health` показывает `"rooms":0`.

### С рабочей машины — `ops/push.sh`

```bash
./ops/push.sh <user>@<server>                   # /var/www/rookfall
./ops/push.sh <user>@<server> /srv/rookfall      # другой каталог
DEPLOY_PORT=2222 ./ops/push.sh <user>@<server>  # нестандартный SSH-порт
```

Та же последовательность, что выше, но без `git fetch`: версия берётся из
локального коммита. Когда репозиторий появится на GitHub, `push.sh` можно
больше не использовать — на сервере сделать `git init && git remote add origin
<url> && git fetch && git reset --hard origin/master`, и дальше работает
`./ops/deploy.sh` и CI.

### Из CI (GitHub Actions)

Джоб `deploy` в [.github/workflows/ci.yml](.github/workflows/ci.yml) выключен,
пока в репозитории не заданы (Settings → Secrets and variables → Actions):

- Variables: `DEPLOY_ENABLED=true`;
- Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PORT` — те
  же, что у соседних проектов.

После этого push в ветку по умолчанию → тесты, детерминизм, сборка → по SSH
`./ops/deploy.sh <sha>` в `/var/www/rookfall`. Пользователь должен быть в
группе `docker`, каталог — клоном репозитория (вариант А).

## 3. Проверка после деплоя

```bash
docker compose ps                                     # rookfall — Up (healthy)
docker compose logs rookfall --tail 30                 # "[server] Rookfall game server on http://localhost:61873"
curl -s http://127.0.0.1:61873/api/health             # ok, version = sha коммита
curl -s https://<домен>/api/health                    # тот же ответ снаружи
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' https://<домен>/models/Mine.gltf   # 200 и ненулевой размер — модели попали в образ
```

Дальше — открыть игру в браузере: скирмиш против бота (клиент и модели),
затем «Создать матч» и войти по ссылке из второй вкладки (это проверка `/ws`
через nginx).

## 4. Откат

Автоматический откат срабатывает, если новая версия не поднялась. Руками:

```bash
cd /var/www/rookfall
docker tag rookfall:previous rookfall:latest && docker compose up -d --no-build --force-recreate
# или пересобрать конкретный коммит:
./ops/deploy.sh <sha>
```

`rookfall:previous` — ровно одна предыдущая сборка; `deploy.sh` после успеха
чистит слои без тегов (`docker image prune -f`), тег остаётся.

## 5. Данные: реплеи

Сервер пишет каждый матч в `DATA_DIR=/data/replays` — это volume
`rookfall_rookfall-data`. Список отдаёт `/api/replays` (100 последних), файл —
`/api/replays/<id>`.

```bash
docker compose exec rookfall ls -la /data/replays
docker compose cp rookfall:/data ./backup-$(date +%F)                 # бэкап
docker compose exec rookfall find /data/replays -name '*.json' -mtime +30 -delete   # чистка старше 30 дней
```

Файлы сами не удаляются — на общем VPS чистку стоит повесить на крон.

## 6. Без Docker — PM2

Соседи blind-kit и poker-kit крутятся в PM2; если Docker на сервере
нежелателен, игра ставится так же. Нужны Node 22 и pnpm 11:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo corepack enable && corepack prepare pnpm@11.15.1 --activate

cd /var/www/rookfall
pnpm install --frozen-lockfile
pnpm assets && pnpm build            # модели из ассет-пака + клиент + сервер
pm2 start ops/ecosystem.config.cjs && pm2 save
```

Обновление: `git pull && pnpm install --frozen-lockfile && pnpm assets &&
pnpm build && pm2 reload rookfall`. Порт тот же 61873, реплеи — в
`/var/www/rookfall/data/replays`; nginx-конфиг из §1 подходит без изменений.

## 7. Без nginx — порт напрямую

Если хостового nginx нет и домен не нужен:

```bash
# .env
ROOKFALL_BIND=0.0.0.0
docker compose up -d                 # пересоздаст контейнер с новой привязкой
sudo ufw allow 61873/tcp
```

Игра открывается по `http://<ip>:61873`; WebSocket идёт по `ws://` — для игры
достаточно, браузеры это не блокируют. TLS в этом варианте нет.

## Примечания

- Хост-порты 61870–61879 закреплены за проектом — не занимать их другими
  сервисами.
- Лимит памяти контейнера 1 ГБ (`deploy.resources.limits.memory` в compose):
  утечка не должна отъесть память у соседей. Симуляция с ботами в норме
  укладывается в сотни мегабайт.
- Логи — `docker compose logs -f rookfall`, ротация json-file 3 × 10 МБ.
- Процесс в контейнере работает под пользователем `node`; при замене volume на
  bind-mount (`./data:/data`) каталог на хосте должен принадлежать uid 1000.
- `/api/health` без версии (`"version":"dev"`) означает сборку без `GIT_SHA` —
  `docker compose up --build` руками, а не через `deploy.sh`. Работает, но
  проверка версии в следующем деплое всё равно отработает, так как сравнивает с
  новым sha.
- Docker-сборки нескольких проектов накапливают слои: изредка
  `docker system prune -f` (без `-a`, чтобы не удалить используемые).
