# Сборка клиента и сервера; в рантайме один Node-процесс раздаёт клиент, /api и /ws.
# Порт 61873 — см. DEPLOY.md (вне 3xxx/8xxx соседей и эфемерного диапазона Linux).
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/sim/package.json packages/sim/
COPY packages/ai/package.json packages/ai/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile
COPY packages packages
# glTF-модели: packages/client/public/models в .gitignore, поэтому нужный набор
# копируется из ассет-пака при сборке — тем же scripts/copy-models.mjs, что и `pnpm assets`
COPY scripts/copy-models.mjs scripts/
COPY ["models/Ultimate Fantasy RTS - Aug 2022/glTF", "models/Ultimate Fantasy RTS - Aug 2022/glTF"]
RUN node scripts/copy-models.mjs && pnpm build

FROM node:22-alpine
# sha разворачиваемого коммита: отдаётся в /api/health как "version",
# по нему ops/deploy.sh проверяет, что поднялась именно новая сборка
ARG GIT_SHA=dev
WORKDIR /app
ENV NODE_ENV=production PORT=61873 DATA_DIR=/data GIT_SHA=$GIT_SHA
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/client/dist packages/client/dist
COPY --from=build /app/node_modules/.pnpm/ws@*/node_modules/ws node_modules/ws
# Процесс не под root; /data (реплеи) должен быть ему доступен на запись
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 61873
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["node", "packages/server/dist/index.js"]
