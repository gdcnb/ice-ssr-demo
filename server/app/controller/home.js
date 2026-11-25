'use strict';

const { Controller } = require('egg');

module.exports = class HomeController extends Controller {
  async render() {
    const { ctx, service } = this;
    const { statusCode, statusText, headers, value, stream, abort } = await service.ssr.render();

    if (statusCode) ctx.status = statusCode;
    if (statusText) ctx.statusMessage = statusText;
    if (headers) {
      for (const [name, val] of Object.entries(headers)) {
        ctx.set(name, val);
      }
    }

    // 流式：接管原生响应，把 SSR Readable 直接 pipe 到 res。
    // 必须 ctx.respond = false，否则 koa 会在 middleware 返回后用 ctx.body 覆盖响应。
    if (stream) {
      ctx.respond = false;
      ctx.type = 'html';
      const res = ctx.res;
      // 客户端断开及时中止渲染，避免无谓的 Suspense 等待
      res.on('close', () => {
        if (typeof abort === 'function') abort();
      });
      stream.on('error', err => {
        ctx.logger.error('[ssr-stream] stream error: %s', err.stack || err.message);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Internal Server Error');
        } else {
          res.destroy(err);
        }
      });
      stream.pipe(res);
      return;
    }

    // 非流式（缓存命中 / stream 关闭）：整串发送
    ctx.type = 'html';
    const html = typeof value === 'string' ? value : '';
    // 开发环境注入热更新客户端（SSE 订阅），生产环境零侵入
    ctx.body = this.app.devReload ? this.app.devReload.inject(html) : html;
  }
};
