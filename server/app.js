'use strict';

const fs = require('fs');
const HtmlCache = require('./lib/html-cache');
const ChatProxy = require('./lib/chat-proxy');
const mockAgent = require('./lib/mock-agent');

/**
 * 加载 webpack 的 SSR 构建产物（dist/server/index.js，CommonJS）。
 *
 * 产物导出与原 ice 产物一致的契约：renderToHTML({ req, res }, options)。
 * 因此 egg 侧的 controller / service / 缓存层无需改动。
 * 用 require 在启动前加载一次并挂到 app 上复用（CJS 天然有模块缓存）。
 */
module.exports = app => {
  // HTML 缓存：每个 worker 一份实例（单进程模式下即全局一份）
  app.htmlCache = new HtmlCache({ max: app.config.htmlCache.max });

  // AI Agent 代理：turn 事件缓冲 + 浏览器/上游两侧断连恢复
  app.chatProxy = new ChatProxy(app);

  // 本地开发才加载热更新模块。放在同步阶段注册，保证 router.js 加载时
  // app.devReload 已经可用（beforeStart 回调执行得更晚）。
  if (app.config.env === 'local') {
    require('./lib/dev-hot-reload')(app);
  }

  app.beforeStart(async () => {
    // 拉起独立的模拟 Agent HTTP 服务，egg 通过 fetch 代理它（真实网络边界）
    mockAgent.start(Number(process.env.AGENT_PORT) || 7002);
    app.coreLogger.info('[mock-agent] upstream ready: %s', app.config.chatProxy.agentUrl);

    const { entry } = app.config.ssr;
    if (!fs.existsSync(entry)) {
      throw new Error(
        `[webpack-ssr] 未找到 SSR 构建产物: ${entry}\n` +
        '请先执行 `npm run dev` 或 `npm run build` 生成 dist/server/index.js。'
      );
    }

    const serverModule = require(entry);
    if (typeof serverModule.renderToHTML !== 'function') {
      throw new Error('[webpack-ssr] SSR 入口未导出 renderToHTML，请确认 webpack 服务端构建是否成功。');
    }
    if (typeof serverModule.renderToStream !== 'function') {
      throw new Error('[webpack-ssr] SSR 入口未导出 renderToStream，流式响应不可用。');
    }

    app.ssrRenderer = serverModule;
    app.coreLogger.info('[webpack-ssr] SSR 渲染模块已加载（支持流式）: %s', entry);
  });
};
