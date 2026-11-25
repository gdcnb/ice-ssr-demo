/**
 * 页面资源映射：服务端注入 <link> 与客户端按需加载共用。
 *
 * 刻意不 import 任何 React / 页面组件，这样客户端 bundle 不会因为引入本文件
 * 而把服务端路由表（静态 import 的所有页面）打进 main.js。
 *
 * chunk 名与 routes-client.tsx 的 webpackChunkName、webpack.config.js 的
 * chunkFilename 三者必须一致：
 *   JS  -> /js/{chunk}.js
 *   CSS -> /css/{chunk}.css
 */
const CHUNK_BY_PATH: Record<string, string> = {
  '/': 'page-index',
  '/home': 'page-home',
  '/ug': 'page-ug',
  '/chat': 'page-chat',
};

export function chunkForPath(pathname: string): string | null {
  return CHUNK_BY_PATH[pathname] || null;
}
