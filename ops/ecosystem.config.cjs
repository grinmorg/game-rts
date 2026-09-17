// Вариант без Docker — PM2, как у соседей blind-kit/poker-kit (DEPLOY.md §6):
//   pnpm install --frozen-lockfile && pnpm assets && pnpm build
//   pm2 start ops/ecosystem.config.cjs && pm2 save
const path = require('node:path');
const root = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'rookfall',
      cwd: root,
      script: 'packages/server/dist/index.js',
      env: {
        NODE_ENV: 'production',
        PORT: 61873, // тот же порт, что в docker-compose.yml и ops/nginx/rookfall.conf
        DATA_DIR: path.join(root, 'data'),
      },
      max_memory_restart: '1G',
      time: true,
    },
  ],
};
