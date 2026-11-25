'use strict';

const path = require('path');
const fs = require('fs');

module.exports = app => {
  const { router, controller, config } = app;

  // AI Agent 流式代理接口：SSE，必须放在通配 SSR 路由之前
  router.post('/api/chat/stream', controller.chat.stream);

  // 本地调试：观察每个 turn 的事件数、订阅者数、上游状态
  if (app.config.env === 'local') {
    router.get('/__chat/turns', ctx => {
      ctx.body = app.chatProxy.stats();
    });
  }

  // favicon 位于 dist 根目录，单独托管，不暴露整个 dist 目录
  router.get('/favicon.ico', async ctx => {
    const file = path.join(config.ssr.buildDir, 'favicon.ico');
    if (!fs.existsSync(file)) return (ctx.status = 404);
    ctx.type = 'image/x-icon';
    ctx.set('cache-control', 'public, max-age=3600');
    ctx.body = fs.createReadStream(file);
  });

  // 本地开发环境下的缓存观测/清理入口（生产环境返回 404）
  if (app.config.env === 'local') {
    // webpack 产物变化的 SSE 推送通道，必须放在通配 SSR 路由之前
    router.get('/__dev/reload', ctx => app.devReload.subscribe(ctx));

    router.get('/__cache/stats', ctx => {
      ctx.body = {
        size: app.htmlCache.store.size,
        stats: app.htmlCache.stats,
        keys: [ ...app.htmlCache.store.keys() ],
      };
    });
    router.get('/__cache/clear', ctx => {
      ctx.body = { cleared: app.htmlCache.clear() };
    });
  }

  // 其余路由统一交给 webpack 的 SSR 渲染器：
  // - /、/home、/ug 由 SSR 渲染出完整 HTML
  // - 未匹配路由返回 404（renderToHTML 内部通过 matchRoutes 判定）
  router.get('/*', controller.home.render);
};
