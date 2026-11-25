import './global.css';
import { Suspense } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { BrowserRouter, useRoutes } from 'react-router-dom';
import { hasClientRoute, prepareClientRoutes } from './routes-client';

/**
 * 开发环境 Fast Refresh：暴露一个由 egg SSE 触发的入口。
 *
 * webpack 的 HMR runtime 只提供 module.hot.check()/apply()，本身不监听任何推送；
 * 标准做法靠 webpack-dev-server 的 WebSocket 客户端来调用 check，这里没有 WDS，
 * 所以挂到 window 上，由 HTML 注入的脚本收到 SSE 事件后调用。
 *
 * 组件模块里的 module.hot.accept / React Refresh 的 register 由
 * @pmmmwh/react-refresh-webpack-plugin + react-refresh/babel 自动注入，无需手写。
 * HMR 未启用时（生产 / build:watch）module.hot 不存在，这段逻辑自动跳过。
 */
declare const module: {
  hot?: {
    check: (autoApply?: boolean) => Promise<unknown[] | null>;
    status: () => string;
  };
};

if (typeof module !== 'undefined' && module.hot) {
  (window as any).__ssrHotCheck = () => module.hot!.check(true);
}

/**
 * 客户端入口：对服务端输出的 HTML 做 hydrate，接管交互。
 *
 * 关键点：先加载当前页 chunk，再用「当前页同步 + 其他页 lazy」的路由表 hydrate。
 * 这样首帧不会 suspend，与服务端渲染结果完全一致；跳转其他页面时才按需加载 chunk。
 */
const container = document.getElementById('ice-container');

if (container) {
  const rawPathname = window.location.pathname;
  const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/+$/, '') : rawPathname;

  if (!hasClientRoute(pathname)) {
    // 404 服务端直接输出 <h1>，没有路由/Suspense 边界，客户端保持一致
    hydrateRoot(container, <h1>404 Not Found</h1>);
  } else {
    prepareClientRoutes(pathname).then(routes => {
      function App() {
        return useRoutes(routes);
      }

      hydrateRoot(
        container,
        <BrowserRouter>
          <Suspense fallback={null}>
            <App />
          </Suspense>
        </BrowserRouter>
      );
    });
  }
}
