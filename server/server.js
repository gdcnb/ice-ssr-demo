'use strict';

// 生产环境启动入口：直接调用 egg 的 start API 拉起应用（单进程模式）。
// 不使用 egg-scripts --daemon，避免依赖 ps 命令（部分受限环境不可用）。
// 用法：npm run server:prod
process.env.EGG_SERVER_ENV = 'prod';

const { start } = require('egg');

(async () => {
  const app = await start({ baseDir: __dirname });
  const port = Number(process.env.PORT) || 7001;
  app.listen(port, () => {
    console.log(`[ice-ssr] egg server listening on http://127.0.0.1:${port} (prod)`);
  });
})().catch(err => {
  console.error('[ice-ssr] failed to start egg server:', err);
  process.exit(1);
});
