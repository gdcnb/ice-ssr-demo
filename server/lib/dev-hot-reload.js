'use strict';

const path = require('path');
const chokidar = require('chokidar');

/**
 * 本地开发热更新（仅 egg local 环境启用）。
 *
 * 三件事：
 *   1. dist/server/index.js 变化 -> 清 require.cache 后重新 require，原地替换
 *      app.ssrRenderer，并清空 HTML 缓存；不重启 egg worker。
 *   2. 提供 SSE 端点 /__dev/reload，把构建事件推给浏览器。
 *   3. 在 SSR HTML 的 </body> 前注入一小段客户端脚本：
 *      - JS / SSR 变化 -> location.reload()
 *      - CSS 变化 -> 原地替换 <link>，不刷新页面、保留组件状态
 *
 * 生产环境完全不加载本模块，没有额外开销。
 */

/** 浏览器端热更新脚本文本（不含 <script> 标签），流式下交给 React bootstrapScriptContent */
const DEV_SCRIPT = `
(function () {
  if (typeof EventSource === 'undefined') return;
  var es = new EventSource('/__dev/reload');
  es.addEventListener('reload', function () { window.location.reload(); });
  es.addEventListener('hmr', function () {
    if (typeof window.__ssrHotCheck !== 'function') {
      window.location.reload();
      return;
    }
    window.__ssrHotCheck().then(function (updates) {
      if (!updates || !updates.length) window.location.reload();
    }).catch(function (err) {
      console.error('[dev-hot] Fast Refresh 失败，降级整页刷新:', err);
      window.location.reload();
    });
  });
  es.addEventListener('css', function (e) {
    var hrefs;
    try { hrefs = JSON.parse(e.data); } catch (err) { return; }
    if (!Array.isArray(hrefs)) return;
    hrefs.forEach(function (href) {
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      for (var i = 0; i < links.length; i++) {
        var link = links[i];
        var current = (link.getAttribute('href') || '').split('?')[0];
        if (current !== href) continue;
        var next = link.cloneNode(false);
        next.href = href + '?t=' + Date.now();
        link.parentNode.replaceChild(next, link);
      }
    });
  });
})();`;

/** 非流式路径：把脚本包成 <script> 注入到 </body> 前 */
function injectDevClient(html) {
  if (typeof html !== 'string' || !html.includes('</body>')) return html;
  return html.replace('</body>', `<script>${DEV_SCRIPT}</script>\n</body>`);
}

module.exports = app => {
  const { buildDir, entry } = app.config.ssr;
  const clients = new Set();

  /** 向所有已连接的浏览器广播一个 SSE 事件 */
  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try {
        client.res.write(frame);
      } catch (_) {
        clients.delete(client);
      }
    }
  }

  /** koa/egg 的 SSE 响应：接管 res，保持连接不结束 */
  function subscribe(ctx) {
    const { req, res } = ctx;
    ctx.respond = false;

    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');

    if (req.socket) {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
    }

    const client = { res };
    clients.add(client);
    res.write('event: connected\ndata: {}\n\n');

    // 心跳，避免代理 / 浏览器把长连接断开
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
  }

  /** 清 require.cache 重新加载 SSR bundle，替换 app 上的渲染器引用 */
  function reloadRenderer() {
    try {
      const serverDir = path.join(buildDir, 'server');
      for (const id of Object.keys(require.cache)) {
        if (id === entry || id.startsWith(`${serverDir}${path.sep}`)) {
          delete require.cache[id];
        }
      }

      const next = require(entry);
      if (typeof next.renderToHTML !== 'function') {
        throw new Error('SSR bundle 未导出 renderToHTML');
      }

      app.ssrRenderer = next;
      app.htmlCache.clear();
      app.coreLogger.info('[dev-hot] SSR 渲染器已热替换，HTML 缓存已清空');
    } catch (err) {
      // 编译中间态可能写出不完整的 bundle，保留旧渲染器继续服务
      app.coreLogger.error('[dev-hot] SSR 渲染器热替换失败: %s', err.stack || err.message);
    }
  }

  // webpack 一次编译会同时写 server bundle 和 client chunk，两边都变化只推一次 reload
  let serverTimer = null;
  let reloadTimer = null;
  let cssTimer = null;
  const reloadReasons = new Set();
  const cssChanged = new Set();

  function scheduleReload(reason) {
    reloadReasons.add(reason);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      const reasons = [ ...reloadReasons ];
      reloadReasons.clear();
      // 只要有客户端 JS 变化就走 Fast Refresh：改组件会同时触发 client 与
      // server bundle 重编，若因 server 也变了就整页刷新，Fast Refresh 就白做了。
      // SSR renderer 的替换在后台完成，下次用户主动刷新才用得上新 HTML。
      // 只有纯 SSR 侧变化（如改 renderToHTML / 文档模板）才必须整页刷新。
      broadcast(reasons.includes('client') ? 'hmr' : 'reload', { reasons });
    }, 150);
  }

  const watcher = chokidar.watch([
    entry,
    path.join(buildDir, 'js', '*.js'),
    path.join(buildDir, 'css', '*.css'),
  ], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on('all', (event, file) => {
    if (event !== 'add' && event !== 'change' && event !== 'unlink') return;

    if (file === entry) {
      clearTimeout(serverTimer);
      serverTimer = setTimeout(reloadRenderer, 80);
      scheduleReload('server');
      return;
    }

    if (file.endsWith('.css')) {
      cssChanged.add(`/css/${path.basename(file)}`);
      clearTimeout(cssTimer);
      cssTimer = setTimeout(() => {
        broadcast('css', [ ...cssChanged ]);
        cssChanged.clear();
      }, 150);
      return;
    }

    if (file.endsWith('.js')) {
      scheduleReload('client');
    }
  });

  // 暴露给 router / controller 使用：inject 用于非流式，devScript 用于流式渲染
  app.devReload = { subscribe, broadcast, inject: injectDevClient, devScript: DEV_SCRIPT, watcher };

  app.on('close', () => {
    watcher.close();
    clearTimeout(serverTimer);
    clearTimeout(reloadTimer);
    clearTimeout(cssTimer);
    for (const client of clients) {
      try {
        client.res.end();
      } catch (_) {
        // 连接已断开
      }
    }
    clients.clear();
  });

  app.coreLogger.info('[dev-hot] 开发热更新已启用，监听 dist 产物变化');
};
