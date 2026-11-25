'use strict';

const path = require('path');

module.exports = appInfo => {
  const config = {};

  config.keys = `${appInfo.name}_ice_ssr_demo_key`;

  // /api/chat/stream 是无会话的 JSON 流式接口，不需要 CSRF token。
  // 关闭全局 CSRF 校验（本 demo 没有登录态，也不处理表单提交）。
  config.security = {
    csrf: { enable: false },
  };

  // webpack 的构建产物目录：静态资源 + SSR server 入口。
  // 产物输出到 dist/，build/ 保留给 icejs；egg 的 baseDir 是 server/，向上一级取。
  const distDir = path.join(appInfo.baseDir, '..', 'dist');
  config.ssr = {
    buildDir: distDir,
    // SSR server 入口（webpack 产出的 CommonJS 模块），由 egg 侧通过 require 加载
    entry: path.join(distDir, 'server', 'index.js'),
    renderMode: 'SSR',
    // 流式响应开关：MISS / BYPASS 时用 renderToPipeableStream 边渲染边发送，
    // 缓存命中（HIT / STALE）仍直接发完整字符串。设为 false 则全程非流式。
    stream: true,
  };

  // AI Agent 代理：egg 不直接生成内容，而是 fetch 独立的上游 Agent 服务。
  // Agent 服务由 server/lib/mock-agent.js 在 beforeStart 中拉起（默认 7002）。
  config.chatProxy = {
    agentUrl: process.env.AGENT_URL
      || `http://127.0.0.1:${Number(process.env.AGENT_PORT) || 7002}/agent/stream`,
    turnTtl: 10 * 60 * 1000, // 一轮对话的事件缓冲保留时长
    graceMs: 60 * 1000,      // 浏览器断开后，多久才停掉上游生成
    heartbeatMs: 15 * 1000,
    reconnectDelay: 300,
  };

  // 按路由配置的 HTML 缓存。rules 按顺序匹配，命中第一条即以该规则缓存；
  // 未命中任何规则 -> 不缓存（BYPASS）。ttl / staleWhileRevalidate 单位为毫秒。
  // match 支持：字符串（精确 pathname，不含 query）或 RegExp。
  config.htmlCache = {
    enable: true,
    max: 500, // LRU 最大条目数
    header: 'x-html-cache', // 响应头标记 HIT / MISS / STALE / BYPASS
    rules: [
      // 示例：首页缓存 60s，过期后 5min 内仍可返回旧内容并后台刷新
      { match: '/', ttl: 60 * 1000, staleWhileRevalidate: 5 * 60 * 1000 },
      // 示例：/home 缓存 30s，不做 SWR
      { match: /^\/home$/, ttl: 30 * 1000, staleWhileRevalidate: 0 },
    ],
  };

  // 由 egg-static 托管 webpack 产物的客户端静态资源。
  // 只映射 /js 与 /css 两个目录，避免把 dist/server 下的 SSR 模块暴露出去；
  // favicon 由 router 单独处理，路径前缀与 webpack 的 publicPath: '/' 一致。
  config.static = {
    dir: [
      { prefix: '/js/', dir: path.join(distDir, 'js') },
      { prefix: '/css/', dir: path.join(distDir, 'css') },
    ],
    dynamic: true,
    preload: false,
    maxAge: appInfo.env === 'prod' ? 60 * 60 * 1000 : 0,
  };

  config.cluster = {
    listen: {
      port: Number(process.env.PORT) || 7001,
    },
  };

  return config;
};
