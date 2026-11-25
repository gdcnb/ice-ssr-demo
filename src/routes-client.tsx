import { createElement, lazy, type ComponentType } from 'react';
import type { RouteObject } from 'react-router-dom';
// import { chunkForPath } from './page-assets';

type PageModule = { default: ComponentType };
type PageLoader = () => Promise<PageModule>;

/**
 * 客户端页面 loader：webpackChunkName 与 page-assets.ts / webpack.config.js 一致。
 * 每个 loader 对应一个独立 JS chunk + 一个独立 CSS chunk。
 */
const pageLoaders: Record<string, PageLoader> = {
  '/': () => import(/* webpackChunkName: "page-index" */ './pages'),
  '/home': () => import(/* webpackChunkName: "page-home" */ './pages/home'),
  '/ug': () => import(/* webpackChunkName: "page-ug" */ './pages/ug'),
  '/chat': () => import(/* webpackChunkName: "page-chat" */ './pages/chat'),
};

/** 默认全部是 lazy 组件，用于 hydrate 之后的客户端导航。 */
const pageComponents: Record<string, ComponentType> = Object.fromEntries(
  Object.entries(pageLoaders).map(([path, loader]) => [path, lazy(loader)])
);

export function hasClientRoute(pathname: string): boolean {
  return Boolean(pageLoaders[pathname]);
}

/**
 * hydrate 前调用：预先加载当前页 chunk，并用已解析的组件替换该页的 lazy 组件。
 *
 * 为什么必须这么做：
 * - React.lazy 首帧必定 suspend，客户端会先渲染 fallback(null)，而服务端 HTML
 *   里是完整页面内容，结构不一致 → hydration 失败。
 * - 服务端 renderToString 会为 Suspense 边界输出 <!--$--> 标记，客户端需要
 *   有同样的边界且不 suspend，才能正确复用服务端 HTML。
 *
 * 加载当前页后，只有这一页是同步组件（保证 hydrate 匹配）；其他页面仍是 lazy，
 * 客户端跳转时才按需下载，分包效果不受影响。
 */
export async function prepareClientRoutes(pathname: string): Promise<RouteObject[]> {
  const loader = pageLoaders[pathname];
  if (loader) {
    const mod = await loader();
    pageComponents[pathname] = mod.default;
  }

  return [
    { path: '/', element: createElement(pageComponents['/']) },
    { path: '/home', element: createElement(pageComponents['/home']) },
    { path: '/ug', element: createElement(pageComponents['/ug']) },
    { path: '/chat', element: createElement(pageComponents['/chat']) },
  ];
}
