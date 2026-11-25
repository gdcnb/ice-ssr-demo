# Next.js SSR 版本（next-demo）

参考父目录 `ice-ssr-demo` 的 SSR 实现（webpack 双端构建 + egg 托管），这里用 **Next.js App Router** 实现等价功能，作为技术选型对照。

## 运行

```bash
cd next-demo
npm install
npm run build   # 等价于父项目的 pnpm build
npm run start   # 生产服务，http://127.0.0.1:3000
npm run dev     # 开发模式（ISR 缓存不生效）
```

> 本项目的 `npm run build` 使用 `--turbopack`：当前沙箱环境下 Next 默认 webpack 构建器与文件系统的 shim 冲突会报错，Turbopack 构建正常。你本地两种都可以。

## 与原 webpack + egg 版本的对照

| 功能 | 原版本（父目录） | Next.js 版本 |
|---|---|---|
| SSR 渲染 | webpack 编译 server bundle，egg 调用 `renderToHTML` 输出 HTML | App Router 默认 Server Component，框架内部完成 SSR |
| 路由 | `src/routes.tsx` + egg 通配路由 | 文件系统路由 `app/page.tsx`、`app/home/page.tsx`、`app/ug/page.tsx` |
| 按页拆 JS | `React.lazy` + `webpackChunkName` + preload | Next.js 天然按路由分包（构建产物表格里的 First Load JS） |
| 按页拆 CSS | `MiniCssExtractPlugin` + 手动插入 `<link>` | CSS Modules 按路由自动拆分和加载 |
| HTML 缓存 | 自研 `html-cache.js`（LRU + TTL + SWR + singleflight） | ISR：`export const revalidate`，天然 stale-while-revalidate |
| 404 | `renderToHTML` 里 `matchRoutes` 判定 | `app/not-found.tsx` |
| 静态资源 | egg-static 映射 `/js`、`/css` | `public/` 目录直接映射 |
| Web 服务 | egg（`server/` 目录） | Next.js 内置服务，无需额外 node 服务 |

## 按路由缓存配置

与父项目 `server/config/config.default.js` 的 `htmlCache.rules` 一一对应：

| 路由 | 原规则 | Next.js 实现 | 响应头 |
|---|---|---|---|
| `/` | ttl 60s + SWR 5min | `app/page.tsx` → `revalidate = 60` | `s-maxage=60, stale-while-revalidate` |
| `/home` | ttl 30s | `app/home/page.tsx` → `revalidate = 30` | `s-maxage=30, stale-while-revalidate` |
| `/ug` | 无规则（BYPASS） | `app/ug/page.tsx` → `dynamic = 'force-dynamic'` | `no-store, must-revalidate` |
| 404 | 不缓存 | 静态 not-found，无 revalidate | `no-store` |

响应头 `x-nextjs-cache: HIT` 可用来观察缓存命中（对应原版的 `x-html-cache`）。

## 目录结构

```
next-demo/
├── app/
│   ├── layout.tsx          # 根布局：html/body、全局 CSS、metadata
│   ├── global.css          # 全局样式（对应 src/global.css）
│   ├── page.tsx            # 首页 Server Component（revalidate = 60）
│   ├── HomeClient.tsx      # 首页交互部分（useState，客户端组件）
│   ├── index.module.css    # 首页样式
│   ├── home/
│   │   ├── page.tsx        # /home（revalidate = 30）
│   │   └── index.module.css
│   ├── ug/
│   │   ├── page.tsx        # /ug（force-dynamic）
│   │   └── index.module.css
│   └── not-found.tsx       # 404 页面
├── public/
│   ├── logo.png
│   └── favicon.ico
├── next.config.js
├── tsconfig.json
└── package.json
```

## 为什么首页拆成两个文件

`export const revalidate` 这类路由段配置只能写在 **Server Component** 里，而首页有 `useState` 交互必须用 `'use client'`。所以：

- `app/page.tsx`（服务端）：声明缓存策略，渲染 `<HomeClient />`
- `app/HomeClient.tsx`（客户端）：负责点赞按钮交互

这与原版本「服务端静态渲染 + 客户端 hydrate 接管交互」的思路一致。

## 验证结果

`npm run build` 输出的路由表：

```
┌ ○ /          First Load JS 124 kB   Revalidate 1m
├ ○ /_not-found                       -
├ ○ /home                              Revalidate 30s
└ ƒ /ug                                ƒ 动态渲染
```

生产模式实测（Chrome headless）：

- 四个路由 SSR 内容正确（Hello ice.js 3 a / Home page / UG page / 404 Not Found）
- 每个路由只加载全局 CSS + 自己的页面 CSS，样式颜色正确
- React hydrate 正常，首页按钮点击 `👍🏻 2 → 👍🏻 3`
- 缓存头：`/` 与 `/home` 为 `x-nextjs-cache: HIT` + `s-maxage`；`/ug` 与 404 为 `no-store`
