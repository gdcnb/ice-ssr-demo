import { Suspense } from 'react';
import { renderToString, renderToPipeableStream } from 'react-dom/server';
import { PassThrough } from 'stream';
import { matchRoutes } from 'react-router-dom';
import { StaticRouter } from 'react-router-dom/server';
import { AppRoutes, routes } from './routes';
import { chunkForPath } from './page-assets';
import { beginDelayRequest } from './ug-delay';

/**
 * 服务端入口：同时提供流式与非流式两套渲染契约。
 *
 *   renderToHTML(req, options)  -> Promise<{ statusCode, headers, value }>   完整字符串
 *   renderToStream(req, options) -> { statusCode, headers, stream, done, abort }
 *
 * 路由匹配、404 判定都在这里完成，egg 只有一条通配路由。
 */

type RenderRequest = {
  url?: string;
  method?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
};

type RenderResult = {
  statusCode: number;
  statusText?: string;
  headers: Record<string, string>;
  value: string;
};

type StreamResult = {
  statusCode: number;
  statusText?: string;
  headers: Record<string, string>;
  /** 逐块产出的完整 HTML 文档流，调用方 pipe 到 HTTP 响应 */
  stream: NodeJS.ReadableStream;
  /** resolve 为完整 HTML 字符串，供缓存层在响应完成后写入 */
  done: Promise<string>;
  /** 客户端断开时中止渲染 */
  abort: () => void;
};

type StreamOptions = {
  renderMode?: string;
  /** 内联脚本内容（如开发热更新的 SSE 客户端），经 React bootstrapScriptContent 注入 */
  devScript?: string;
};

const BOOTSTRAP = '/js/main.js';

/** 文档头：head + 容器起始标签，流式与非流式共用，保证 HTML 结构一致 */
function documentHead(title: string, chunk: string | null): string {
  const chunkCss = chunk
    ? `<link rel="stylesheet" href="/css/${chunk}.css" data-page-css="${chunk}" />`
    : '';
  const chunkPreload = chunk
    ? `<link rel="preload" as="script" href="/js/${chunk}.js" />`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<meta name="description" content="webpack + egg SSR demo" />
<link rel="icon" href="/favicon.ico" />
<title>${title}</title>
<link rel="stylesheet" href="/css/main.css" />
${chunkCss}
${chunkPreload}
</head>
<body>
<div id="ice-container">`;
}

const DOCUMENT_TAIL = '</div>\n</body>\n</html>';

function renderDocument(appHtml: string, title: string, chunk: string | null): string {
  return `${documentHead(title, chunk)}${appHtml}<script src="${BOOTSTRAP}"></script>${DOCUMENT_TAIL}`;
}

function normalizePath(url: string): string {
  const raw = (url || '/').split('?')[0];
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
}

function makeApp(url: string) {
  return (
    <StaticRouter location={url}>
      <Suspense fallback={null}>
        <AppRoutes />
      </Suspense>
    </StaticRouter>
  );
}

/** 非流式渲染：保留给缓存后台刷新 / 404 / 不支持流式的调用方 */
export async function renderToHTML(
  { req }: { req?: RenderRequest; res?: unknown },
  _options?: { renderMode?: string }
): Promise<RenderResult> {
  const url = req?.url || '/';
  const pathname = normalizePath(url);
  beginDelayRequest(false);

  const matched = matchRoutes(routes, pathname);
  if (!matched || matched.length === 0) {
    return {
      statusCode: 404,
      statusText: 'Not Found',
      headers: {},
      value: renderDocument('<h1>404 Not Found</h1>', '404 Not Found', null),
    };
  }

  // 服务端页面是静态 import，不会 suspend，输出完整内容而非 fallback。
  const appHtml = renderToString(makeApp(url));
  const chunk = chunkForPath(pathname);

  return {
    statusCode: 200,
    headers: {},
    value: renderDocument(appHtml, 'webpack SSR Demo', chunk),
  };
}

/**
 * 流式渲染：返回 Node Readable，调用方 pipe 到 HTTP 响应即可逐块发送。
 *
 * 时序：先立即写入文档头（浏览器可提前下载 CSS / 页面 JS）；
 * onShellReady 时把 React 输出接进中转流；异步边界就绪后继续推入；
 * React 结束中转流时补上文档尾。整段 HTML 同时被收集到 done Promise 供缓存使用。
 * bootstrap script 交给 React 注入，避免与模板重复。
 */
export function renderToStream(
  req: RenderRequest | undefined,
  options: StreamOptions = {}
): StreamResult {
  const url = req?.url || '/';
  const pathname = normalizePath(url);
  beginDelayRequest(true);
  const matched = matchRoutes(routes, pathname);

  let resolveDone!: (html: string) => void;
  const done = new Promise<string>(resolve => { resolveDone = resolve; });

  // 404 不值得流式：一次性写出完整文档，行为与非流式一致
  if (!matched || matched.length === 0) {
    const pass = new PassThrough();
    const html = renderDocument('<h1>404 Not Found</h1>', '404 Not Found', null);
    pass.end(html);
    resolveDone(html);
    return {
      statusCode: 404,
      statusText: 'Not Found',
      headers: {},
      stream: pass,
      done,
      abort: () => {},
    };
  }

  const chunk = chunkForPath(pathname);
  const head = documentHead('webpack SSR Demo', chunk);

  // 外层 output 是给 egg 消费的文档流；内层 reactPass 承接 React 输出。
  // 分两层是为了在 React 结束后、output 结束前插入文档尾（pipe 会 end 目标流）。
  const output = new PassThrough();
  const reactPass = new PassThrough();
  let reactHtml = '';

  reactPass.on('data', c => {
    reactHtml += c.toString();
    output.write(c);
  });
  reactPass.on('end', () => {
    output.end(DOCUMENT_TAIL);
    resolveDone(`${head}${reactHtml}${DOCUMENT_TAIL}`);
  });

  output.write(head);

  const { pipe, abort } = renderToPipeableStream(makeApp(url), {
    bootstrapScripts: [ BOOTSTRAP ],
    ...(options.devScript ? { bootstrapScriptContent: options.devScript } : {}),
    onShellReady() {
      pipe(reactPass);
    },
    onShellError(err) {
      // shell 阶段就失败：无法继续流式，降级为一次性完整文档
      abort();
      beginDelayRequest(false);
      const fallback = renderToString(makeApp(url));
      const html = renderDocument(fallback, 'webpack SSR Demo', chunk);
      output.end(html);
      resolveDone(html);
    },
    onError(err) {
      // 单个 Suspense 边界失败会由 React 输出客户端重试脚本，记录即可
      console.error('[ssr-stream] render error:', err);
    },
  });

  return { statusCode: 200, headers: {}, stream: output, done, abort };
}
