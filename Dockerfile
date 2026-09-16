# Build client + server, serve both from one Node process on :8080
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
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/client/dist packages/client/dist
COPY --from=build /app/node_modules/.pnpm/ws@*/node_modules/ws node_modules/ws
VOLUME /data
EXPOSE 8080
CMD ["node", "packages/server/dist/index.js"]
