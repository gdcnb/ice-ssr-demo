# webpack + Egg.js SSR Demo

本项目用 **webpack** 替代 ice 完成前后端双端构建，由 **Egg.js** 托管 SSR 产物对外提供 web 服务。
目录结构保持不变：`src/` 前端源码、`server/` 服务端代码，两者通过约定产物目录 `dist/` 对接。
`build/` 保留给 icejs，两套方案的构建产物可同时存在、直接对比。

## Usage

```bash
$ pnpm install

# 开发：一条命令启动 webpack --watch + egg（默认 http://127.0.0.1:7001）
# 改 src/ 或 server/ 下的代码会自动重编译并热更新，详见下文
$ pnpm dev

# 也可以手动分步启动（无热更新）：
$ pnpm build
$ pnpm server

# 生产：先构建，再启动
$ pnpm build
$ pnpm server:prod
# 可用 PORT 环境变量指定端口，例如 PORT=8080 pnpm server:prod

# icejs 方案：构建到 build/（与 webpack 的 dist/ 互不覆盖，可对比产物）
$ pnpm build:ice
$ pnpm dev:ice
```

启动后验证：

- `GET /`、`/home`、`/ug`：SSR 渲染的完整 HTML
- `GET /js/main.js`、`/css/main.css`、`/js/logo.png`、`/favicon.ico`：静态资源
- 未匹配路由返回 404
- `dist/server/*` 不对外暴露

### 构建产物

`webpack.config.js` 导出两份配置，一次 `webpack` 命令同时编译：

| 配置 | 入口 | 产物 | 说明 |
|---|---|---|---|
| client | `src/entry-client.tsx` | `dist/js/main.js` + 每页一个 `page-*.js` | 浏览器 hydrate，框架在 main，页面按需加载 |
| server | `src/entry-server.tsx` | `dist/server/index.js` | CommonJS，`renderToString` + 路由匹配 + 404 判定 |

### 按页面拆分 bundle

客户端用 `React.lazy` + `import(/* webpackChunkName: "page-xxx" */)` 把每个页面打成独立 chunk，浏览器不再一次下载所有页面 JS：

```
dist/js/main.js        1.4M   React / ReactDOM / react-router / runtime（所有页面共享）
dist/js/page-index.js  5.5K   首页
dist/js/page-home.js   2.0K   /home
dist/js/page-ug.js     2.0K   /ug
dist/css/main.css      720B   全局样式（global.css）
dist/css/page-index.css 1.4K  首页样式
dist/css/page-home.css  1.0K  /home 样式
dist/css/page-ug.css    1.0K  /ug 样式
```

JS 和 CSS 都按页面拆分：浏览器首屏只下载 `main.js` + 当前页 `page-xxx.js/.css`，导航到其他页时才加载对应资源。

- `src/routes-client.tsx`：页面 loader 用 `import(/* webpackChunkName: "page-xxx" */)` 独立成 chunk；`withCss()` 包装 loader，在 JS chunk 加载时插入对应 CSS `<link>`（服务端已注入的同名 link 用 `data-page-css` 标记跳过）。`prepareClientRoutes(pathname)` 在 hydrate 前预加载**当前页** chunk，并用解析后的组件替换该页的 lazy 组件；其他页面仍是 lazy，跳转时才加载。
- `src/routes.tsx`：服务端路由表（静态 import），用于路由匹配和 404 判定。
- `src/page-assets.ts`：两端共用的 path → chunk 名映射（不 import 页面组件，避免把服务端路由表打进 main.js）。
- `src/entry-server.tsx`：用 `<Suspense>` 包裹路由（React 18 的 `renderToString` 会输出 `<!--$-->` 标记，客户端必须有相同边界才能正确 hydrate），并按当前 path 注入 `<link rel="stylesheet" href="/css/page-xxx.css">` 和 `<link rel="preload" as="script" href="/js/page-xxx.js">`；404 页只注入全局 CSS。
- `src/entry-client.tsx`：**先加载当前页 chunk 再 hydrate**（不是先 hydrate 再等 lazy）。这样首帧不 suspend，React 不会用 `fallback(null)` 覆盖服务端 HTML；404 页面直接 hydrate 一个 `<h1>`，与服务端输出一致。
- `webpack.config.js`：`output.chunkFilename = 'js/[name].js'` 与 `MiniCssExtractPlugin.chunkFilename = 'css/[name].css'` 保证异步 chunk 的 JS/CSS 文件名稳定可预测；移除了原先把所有 CSS 强制合并进 `main` 的 `splitChunks` 规则。

> 注意：不能简单地让客户端首帧就渲染 lazy 路由——`React.lazy` 在 hydrate 时必定 suspend 一次并渲染 fallback，而服务端 HTML 里是完整内容，会触发 `Hydration failed because the initial UI does not match what was rendered on the server`。

新增页面需在 `routes-client.tsx` 的 `pageLoaders` 加一条 loader（同时在 `pageComponents` 自动生成的 lazy 表内）、在 `routes.tsx` 加一条静态路由、在 `page-assets.ts` 加 `chunkForPath` 映射，并在 `prepareClientRoutes` 的返回路由里加对应项——四处 chunk 名保持一致（JS/CSS 文件名由它决定）。

> 注意：`mini-css-extract-plugin` 不会为异步 chunk 自动注入 `<link>`（浏览器不认识 webpack 的 chunk 机制），所以客户端导航时的 CSS 必须由 `withCss()` 手动插入；首屏则由服务端 HTML 直接输出，避免 FOUC。

样式用 CSS Modules（`.module.css` / `.module.scss`），两端共用同一套 `localIdentName`，保证 SSR 与 hydrate 的 className 一致；服务端用 css-loader 的 `exportOnlyLocals` 只取 className、不产出 CSS。全局样式 `src/global.css` 仍由入口引入，单独打进 `main.css`。

### 工作原理

- `src/routes.tsx` 是服务端路由表 + path→chunk 映射（对应原 ice 的文件系统路由 `src/pages/*`），客户端路由在 `src/routes-client.tsx`。
- `src/entry-server.tsx` 导出 `renderToHTML({ req, res }, options)`（返回 `{ statusCode, headers, value }`，与原 ice 产物契约一致）与 `renderToStream(req, options)`（返回流式结果，供流式响应使用）。
- `server/app.js` 在 `beforeStart` 阶段用 `require` 加载 CJS 入口并挂到 `app.ssrRenderer`。
- `server/app/service/ssr.js` 把 egg 的 `ctx.req/ctx.res` 交给渲染器，并在其前面加 HTML 缓存层。
- `server/app/controller/home.js` 把 `statusCode / headers / value` 写回 egg 响应。
- `server/app/router.js` 把 favicon 单独托管，其余 `/*` 路由全部走 SSR。
- 所有 egg 代码集中在 `server/`，与前端 `src/` 分离；egg 的 baseDir 即 `server/`，产物路径在 `server/config/config.default.js` 中通过 `../dist` 指向项目根目录。

手动分步启动时，修改前端代码需要重新 `pnpm build` 并重启 egg（egg 只在启动时 `require` 一次产物）；开发时建议直接用 `pnpm dev`，见下节。

### 两套方案共存

`build/` 与 `dist/` 同时保留，分别对应 icejs 与 webpack 的构建产物，egg 默认读 `dist/`：

| 命令 | 构建工具 | 产物目录 | SSR 入口 |
|---|---|---|---|
| `pnpm build` / `pnpm dev` | webpack | `dist/` | `dist/server/index.js`（CJS） |
| `pnpm build:ice` / `pnpm dev:ice` | icejs | `build/` | `build/server/index.mjs`（ESM） |

`src/pages/` 与 `src/components/` 是两套方案共用的页面源码；`entry-*.tsx`、`routes*.tsx`、`page-assets.ts`、`ice-link-shim.ts` 为 webpack 方案专用，`app.ts`、`document.tsx`、`typings.d.ts` 为 ice 方案专用，互不参与对方的构建。

共用的导航组件统一写 `import { Link } from 'ice'`：`ice` 构建用其运行时虚拟模块（Link 由 `@ice/runtime` 从 react-router-dom re-export，和 ice 自己的 Router context 同源）；webpack 构建没有该虚拟模块，由 `resolve.alias` 把精确的 `ice` 映射到 `src/ice-link-shim.ts`（同样 re-export react-router-dom 的 Link，此时页面被 `BrowserRouter`/`StaticRouter` 包裹）。这样一份组件源码在两套方案里各用各的 Link，不需要在组件里写构建工具判断。若直接 `import { Link } from 'react-router-dom'`，ice 预渲染会因拿不到 Router context 而报 `Cannot destructure property 'basename'` 并降级成 CSR。

切换到 ice 方案需要把 `server/config/config.default.js` 的 `entry` 指回 `build/server/index.mjs` 并改用动态 `import()` 加载 ESM（egg 侧当前按 webpack 的 CJS 契约实现）。

## 流式 SSR 响应

缓存未命中时走 React 18 的 `renderToPipeableStream`，边渲染边把 HTML 发给浏览器，异步边界（`Suspense`）就绪前先送首屏 shell，就绪后继续推送内容并插入客户端接管脚本。

**直接观察**：`/ug` 页面内置了一个演示用的 3 秒延迟边界（标题、导航、fallback 先到，3 秒后推送 `UG content`）。`curl -N http://127.0.0.1:7001/ug` 可看到分块到达，实测 **TTFB 约 3ms、完整响应约 3 秒**。该延迟只在流式渲染时生效：浏览器 hydrate、ice 构建、非流式 `renderToHTML` 均不延迟。不需要时删除 `src/pages/ug/index.tsx` 中的 `Suspense` 包裹与 `suspendForDelay()` 调用即可。

开关在 `server/config/config.default.js` 的 `config.ssr.stream`（默认 `true`）。设为 `false` 则全程用非流式的 `renderToHTML`，`/ug` 的演示延迟也会自动失效。

分三层配合：

| 层 | 文件 | 职责 |
|---|---|---|
| 渲染 | `src/entry-server.tsx` | 导出 `renderToStream`，用两层 `PassThrough`：React pipe 进内层，内层结束后补文档尾再结束外层；同时用 `done` Promise 收集完整 HTML |
| 缓存 | `server/app/service/ssr.js` | MISS / BYPASS 走流式，渲染完成后用 `done` 的完整 HTML 写缓存；HIT / STALE 仍发整串（流式无意义） |
| 响应 | `server/app/controller/home.js` | 流式分支设 `ctx.respond = false`，把 Readable 直接 pipe 到原生 `ctx.res`；客户端断开时调用 `abort()` |

几个关键处理：

- **HTML 外壳顺序**：先写 `<head>`（浏览器可提前下载 CSS 和 preload 的页面 JS），再接 React 输出，最后补 `</div></body></html>`。`bootstrap script` 交给 React 的 `bootstrapScripts` 注入，模板不再写 `<script src="/js/main.js">`，避免重复。
- **dev 热更新脚本**：非流式走 `devReload.inject()`；流式转成脚本文本经 `bootstrapScriptContent` 注入（`devReload.devScript`），两种方式都只注入一次。
- **降级**：`onShellError`（shell 阶段失败）回退到 `renderToString` 一次性输出完整文档；单个 Suspense 边界失败由 React 输出客户端重试脚本；流 `error` 时未发头则回 500，已发头则销毁连接。
- **状态码与头**：必须在写流之前通过 `ctx.set` 设置（`x-html-cache` 等），因此 service 先返回 meta，controller 设完头再 pipe。
- **并发合并的取舍**：非流式 MISS 用 singleflight 合并并发请求；流式下 Readable 只能消费一次、无法跨请求共享，因此流式 MISS 不合并，首个请求渲染完写入缓存后，后续请求即命中 HIT。

## AI Agent Chat：Egg 代理 + fetch + ReadableStream 流式演示

访问 `/chat`，输入问题后回答逐字出现（打字机效果）。**Egg 不再自己生成内容**：它通过 `fetch` 代理一个独立的模拟 Agent HTTP 服务（默认 `127.0.0.1:7002/agent/stream`），浏览器只和 Egg 打交道。这样就能在同一份 demo 里观察两处断连的恢复路径。

启动 `pnpm dev` 或 `pnpm build && pnpm server:prod` 时，Egg 在 `beforeStart` 自动拉起 7002 端口的模拟 Agent；也可用 `AGENT_PORT` / `AGENT_URL` 覆盖地址。

### SSE 协议

每帧带标准 `id:`（单调 seq），断点用 `Last-Event-ID` 传递：

```text
id: 1
data: {"seq":1,"type":"start","turnId":"...","total":185}

id: 2
data: {"seq":2,"type":"delta","content":"你"}

id: 187
data: {"seq":187,"type":"done","total":185}
```

```bash
# 首次请求：前端生成 turnId，cursor=0
curl -N -X POST http://127.0.0.1:7001/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"turnId":"demo-1","message":"你好","cursor":0}'

# 断线重连：复用 turnId，带 Last-Event-ID / cursor
curl -N -X POST http://127.0.0.1:7001/api/chat/stream \
  -H 'Content-Type: application/json' \
  -H 'Last-Event-ID: 74' \
  -d '{"turnId":"demo-1","message":"你好","cursor":74}'
```

### 三个场景

| 场景 | 注入方式 | 现象 | 恢复方 |
|---|---|---|---|
| 正常 | 不勾选故障 | 一次拿到全部事件，`done` 后连接关闭 | 无需恢复 |
| 断连 A：浏览器 ↔ Egg | 页面选「浏览器断网（A）」或请求带 `fail:true` | Egg 在 40% 处断开浏览器连接，上游仍在继续生成 | 浏览器带同一 `turnId` + `Last-Event-ID` 重连，Egg 从事件缓冲回放缺失部分 |
| 断连 B：Egg ↔ Agent | 页面选「上游断连（B）」或请求带 `upstreamFail:true` | Agent 在 40% 处断开到 Egg 的连接，**浏览器侧不断线** | Egg 带自己的 `lastSeq` 重新 `fetch` Agent，用户无感 |

实测：正常 / 断连 B 均收到 187 帧完整事件；断连 A 首次收到 74 帧后断开，重连从 seq 75 补到 187。Egg 日志可见：

```text
[chat-proxy] turn=... simulate browser disconnect at seq=75
[chat-proxy] turn=... reconnect upstream from seq=75 (terminated)
```

### 为什么用 fetch + ReadableStream 而不是 EventSource

| | EventSource | fetch + ReadableStream（本 demo） |
|---|---|---|
| 请求方法 | 只能 GET | 可 POST、带请求体与 turnId |
| 流控制 | 浏览器全托管，拿不到 chunk | `getReader()` 逐块读，可精确解析与渲染 |
| 取消 | 只能 `close()` | `AbortController` 精确取消 |
| 重连 | 浏览器自动，但拿不到本轮身份 | 自己控制，带 `turnId` + `Last-Event-ID` 精确续传 |

### 关键实现

| 文件 | 职责 |
|---|---|
| `server/lib/mock-agent.js` | 独立模拟 Agent 服务：按 `Last-Event-ID` 续传，`upstreamFail` 注入断连 B |
| `server/lib/chat-proxy.js` | turn 事件缓冲、按 seq 回放、订阅者管理、浏览器断开宽限期、上游自动重连 |
| `server/lib/chat-corpus.js` | 两端共用的固定语料 |
| `server/app/controller/chat.js` | 薄控制器，把原生 req/res 交给代理层 |
| `src/lib/sse-chat.ts` | 解析 `id:` 为 seq，发送 `Last-Event-ID`，按 seq 去重，`StreamInterrupted` 携带游标 |
| `src/pages/chat/index.tsx` | 生成并复用 `turnId`、记录 seq 游标、故障模式选择、指数退避重试 |

几个容易踩的点：

- **cursor 是事件序号，不是字符数**：字符数在多字节与重复文本场景下不可靠，也无法表达 `start` / `done` 这类控制事件。
- **重试必须复用 turnId**：直接把原 prompt 再发一遍会开启新一轮生成，导致重复内容与重复计费。
- **浏览器断开不立刻停上游**：Egg 保留 60s 宽限期（`config.chatProxy.graceMs`），让快速重连能挂回同一个 turn；超时才 abort Agent，省成本。
- **终态也要进缓冲**：`done` / `error` 一起回放，迟到重连才能正常结束，不会永远挂着。
- **回放与实时流会重叠**：客户端按 seq 去重，避免同一事件上屏两次。
- **多实例部署**：当前 turn 缓冲是进程内 `Map`；多 worker / 多机要换成 Redis（带 TTL）或做 sticky session，否则重连可能落到没有缓冲的实例。
- **代理缓冲**：Egg 已设置 `X-Accel-Buffering: no` 并定期发 `: ping`，避免 nginx 缓冲或长连接被中间层掐断。
- **CSRF**：egg 默认对 POST 校验 CSRF token；本 demo 是无会话的 JSON 接口，在 `server/config/config.default.js` 里关掉了 `config.security.csrf`。

## 开发环境热更新

`pnpm dev` 由 `scripts/dev.js` 串起首次构建、`webpack --watch` 和 `egg-bin dev`，改 `src/` 下的代码后自动更新：

| 改动类型 | 行为 |
|---|---|
| 页面 JSX / SSR 逻辑 | 重编 client + server，egg 清 `require.cache` 后原地替换渲染器，浏览器整页刷新 |
| CSS / CSS Modules | 重编 CSS，浏览器原地替换 `<link>`，不刷新页面，保留组件 state |
| `server/` 下的 egg 代码 | egg-bin 自带 watcher 重启 worker |

实现要点都在 `server/lib/dev-hot-reload.js`：

- 监听 `dist/server/index.js`：清 `require.cache` 后重新 `require`，替换 `app.ssrRenderer` 并清空 HTML 缓存，**不重启 egg 进程**，不影响正在处理的请求。
- 监听 `dist/js/*.js`、`dist/css/*.css`：通过 SSE 端点 `/__dev/reload` 推给浏览器。JS 变更触发 `location.reload()`，CSS 变更只换 `<link href>` 并带时间戳绕过缓存。
- 每个 egg worker 各自持有一份 SSE 连接和渲染器引用；egg 本地开发默认单 worker。
- 生产环境（`pnpm server:prod`）不加载该模块，HTML 不注入脚本，`/__dev/reload` 走通配 SSR 路由返回 404。

### React Fast Refresh（组件 state 保留）

`pnpm dev` 默认启用 React Fast Refresh：改组件源码时，webpack 生成 `.hot-update` 增量包，浏览器通过 `module.hot.check()` 局部替换组件，**state 不重置**。链路如下：

```
改 src/pages/*.tsx
  -> webpack 重编 client，产出 dist/js/*.hot-update.{js,json}（落在 /js/ 下，egg-static 直接服务）
  -> SSE /__dev/reload 推 hmr 事件
  -> 浏览器调用 window.__ssrHotCheck()（entry-client.tsx 暴露）
  -> React Refresh runtime 局部更新组件；失败时自动降级 location.reload()
```

- 只在 `scripts/dev.js` 设置 `SSR_HMR=true` 时启用：`react-refresh/babel`（仅 client）+ `HotModuleReplacementPlugin` + `@pmmmwh/react-refresh-webpack-plugin`。普通 `pnpm build` / `pnpm build:watch` 不带这个变量，产物里没有 Refresh runtime。
- 增量包通过 `/js/` 前缀对外服务，`output.hotUpdateMainFilename` / `hotUpdateChunkFilename` 都指到 `js/` 目录，与 egg-static 的映射对齐。
- SSR bundle 变化仍走后台 renderer 热替换（清 `require.cache`），不触发整页刷新；只有纯 SSR 侧改动（如 `renderToHTML` / 文档模板）才推 `reload`。
- 降级路径：hot check 返回空更新或抛错（如组件导出不符合 Refresh 规则、语法错误），客户端脚本自动 `location.reload()`。
- 限制：Fast Refresh 要求模块只导出 React 组件，混入普通函数/常量导出时会退回整页刷新（这是 React Refresh 本身的规则，不是本项目限制）。

## 按路由做 HTML 缓存

SSR 渲染结果可在 `server/app/service/ssr.js` 层缓存，规则配置在 `server/config/config.default.js` 的 `config.htmlCache.rules`（按顺序匹配，命中第一条）：

```js
config.htmlCache = {
  enable: true,
  max: 500,                 // LRU 最大条目数
  header: 'x-html-cache',   // 响应头标记缓存状态
  rules: [
    { match: '/',            ttl: 60 * 1000, staleWhileRevalidate: 5 * 60 * 1000 },
    { match: /^\/home$/,     ttl: 30 * 1000, staleWhileRevalidate: 0 },
    // 可按 header 区分缓存，例如 { match: /^\/user$/, ttl: 10000, vary: ['cookie'] }
  ],
};
```

- `match`：字符串为精确 pathname，正则按 pathname 测试；缓存 key = `pathname + query`(+ `vary` 指定 header)。
- `ttl`：有效期（毫秒）。`staleWhileRevalidate`：过期后仍可返回旧 HTML 的宽限期，期间后台异步刷新，不阻塞用户。
- 响应头 `x-html-cache` 取值：`HIT` / `MISS` / `STALE` / `BYPASS`（未匹配规则或响应非 200 时实时渲染、不缓存）。
- 同一 key 的并发请求用 singleflight 合并，只渲染一次；404 等非 200 响应不缓存。
- 缓存实现见 `server/lib/html-cache.js`（LRU + TTL + SWR + 并发合并），每个 worker 一份实例。
- 本地开发可访问 `/__cache/stats` 查看命中统计和 key 列表，`/__cache/clear` 清空缓存（生产环境返回 404）。

验证方式：

```bash
curl -I http://127.0.0.1:7001/home   # 首次 MISS，再次 HIT
curl -s http://127.0.0.1:7001/__cache/stats
```

> 提示：当前是进程内缓存，多 worker / 多实例部署时各进程缓存不共享，需要换成 Redis 等共享存储；含登录态的页面务必配 `vary` 或不要缓存。

## Directories

```md
.
├── README.md
├── webpack.config.js               # webpack 双端构建配置（client + server）
├── package.json
├── .browserslistrc                 # 客户端 babel 编译目标
├── public/favicon.ico              # 静态资源源（构建时复制到 dist/）
├── dist                            # webpack 构建产物（pnpm build / pnpm dev）
│   ├── js/main.js                  # 客户端主 bundle（框架 + runtime）
│   ├── js/page-*.js                # 按页面拆分的异步 chunk（首页/home/ug/chat）
│   ├── css/main.css                # 全局样式（global.css）
│   ├── css/page-*.css              # 按页面拆分的样式（首页/home/ug/chat）
│   ├── favicon.ico
│   └── server/index.js             # SSR 渲染入口（CJS）
├── build                           # icejs 构建产物（pnpm build:ice / pnpm dev:ice）
│   ├── index.html                  # ice 生成的 SSG/SSR 页面
│   ├── js/                         # ice 的客户端 bundle
│   ├── css/
│   └── server/index.mjs            # ice 的 SSR 渲染入口（ESM）
├── server                          # egg 服务端代码（与前端 src 分离）
│   ├── app.js                      # 启动钩子：加载 SSR 渲染模块 + 拉起模拟 Agent
│   ├── server.js                   # 生产环境启动入口
│   ├── lib/html-cache.js           # HTML 缓存实现
│   ├── lib/chat-corpus.js          # chat 固定语料（代理与上游共用）
│   ├── lib/mock-agent.js           # 独立模拟 Agent HTTP 服务（7002）
│   ├── lib/chat-proxy.js           # turn 缓冲 / 断点回放 / 两侧断连恢复
│   ├── config/config.default.js    # egg 配置（含 chatProxy.agentUrl）
│   └── app
│       ├── router.js
│       ├── controller/home.js      # SSR 响应
│       ├── controller/chat.js      # SSE 代理入口（薄 controller）
│       └── service/ssr.js
├── src                             # 前端源码
│   ├── entry-client.tsx            # 客户端 hydrate 入口（lazy + Suspense）
│   ├── entry-server.tsx            # SSR 渲染入口（renderToHTML + renderToStream 流式）
│   ├── routes-client.tsx           # 客户端路由（lazy 分包 + CSS 按需插入）
│   ├── routes.tsx                  # 服务端路由表
│   ├── page-assets.ts              # 两端共用的 path→chunk 映射
│   ├── lib/sse-chat.ts             # fetch + ReadableStream 消费 SSE 的封装
│   ├── ice-link-shim.ts            # webpack 侧对 ice 虚拟模块的 Link 兼容层
│   ├── ug-delay.ts                 # /ug 流式演示：3s 延迟开关（仅服务端流式生效）
│   ├── global.css
│   ├── assets
│   ├── pages                       # 页面组件（沿用原 ice 文件）
│   └── (app.ts / document.tsx / typings.d.ts —— ice 专用，不参与 webpack 构建)
├── ice.config.mts                  # ice 配置（pnpm build:ice / pnpm dev:ice 使用）
└── tsconfig.json
```
