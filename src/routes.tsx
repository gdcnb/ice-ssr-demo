import { useRoutes } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';
import IndexPage from './pages';
import HomePage from './pages/home';
import UgPage from './pages/ug';
import ChatPage from './pages/chat';

/**
 * 服务端路由表：静态 import（服务端 bundle 不发给浏览器，无需分包）。
 * 服务端用 matchRoutes 匹配并判定 404；首屏渲染出完整 HTML。
 */
export const routes: RouteObject[] = [
  { path: '/', element: <IndexPage /> },
  { path: '/home', element: <HomePage /> },
  { path: '/ug', element: <UgPage /> },
  { path: '/chat', element: <ChatPage /> },
];

/** 服务端用：由 StaticRouter 提供 location 上下文 */
export function AppRoutes() {
  return useRoutes(routes);
}
