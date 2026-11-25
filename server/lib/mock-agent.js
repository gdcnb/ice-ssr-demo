'use strict';

const http = require('http');
const { pickReply } = require('./chat-corpus');

/**
 * 模拟「真正的 Agent 服务」：一个独立 HTTP 服务，Egg 只通过 fetch 代理它。
 *
 * 它支持 SSE 标准的断线续传语义：
 * - 每个事件都带 id: <seq>，seq 单调递增
 * - 重连请求带 Last-Event-ID: <seq>，服务从 seq 之后继续推
 * - fail=1 时模拟 Egg <-> Agent 之间断连（断连 B），用于验证代理侧重连
 *
 * 注意：这个服务按 message 重新推导全文，相当于上游自己保存了事件日志。
 * 真实 Agent 服务应从持久化存储里按 turnId 读取事件，而不是重新生成。
 */

const TOKEN_INTERVAL = 40;
const FIRST_TOKEN_DELAY = 150;
const FAIL_RATIO = 0.4;

let server = null;
let currentPort = null;

function writeEvent(res, seq, payload) {
  res.write(`id: ${seq}\ndata: ${JSON.stringify({ seq, ...payload })}\n\n`);
}

function handleStream(req, res) {
  if (req.method !== 'POST' || req.url !== '/agent/stream') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  let raw = '';
  req.on('data', chunk => {
    raw += chunk;
  });
  req.on('error', () => {});

  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch (_) {
      body = {};
    }

    const turnId = String(body.turnId || '');
    const message = String(body.message || '');
    const headerSeq = Number(req.headers['last-event-id']);
    const fromSeq = Math.max(
      0,
      Number.isFinite(headerSeq) && req.headers['last-event-id'] !== undefined
        ? headerSeq
        : Number(body.fromSeq) || 0
    );
    const injectFail = Boolean(body.fail);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.on('error', () => {});

    const tokens = Array.from(pickReply(message));
    const total = tokens.length;
    // seq 1 是 start，seq 2..total+1 是 delta，seq total+2 是 done。
    let index = Math.max(0, fromSeq - 1);
    let seq = fromSeq;
    let stopped = false;
    let timer = null;

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };

    res.on('close', cleanup);
    req.on('aborted', cleanup);

    if (fromSeq === 0) {
      writeEvent(res, ++seq, { type: 'start', turnId, total });
    }

    const failAt = index + Math.floor((total - index) * FAIL_RATIO);
    const tick = () => {
      if (stopped) return;

      // 模拟断连 B：Egg 与 Agent 之间断开，浏览器到 Egg 的连接仍然是好的
      if (injectFail && index >= failAt) {
        console.warn(`[mock-agent] turn=%s simulate upstream break at seq=%d`, turnId, seq);
        stopped = true;
        if (timer) clearTimeout(timer);
        res.destroy(new Error('simulated upstream break'));
        return;
      }

      if (index >= total) {
        writeEvent(res, ++seq, { type: 'done', total });
        cleanup();
        res.end();
        return;
      }

      writeEvent(res, ++seq, { type: 'delta', content: tokens[index] });
      index += 1;
      timer = setTimeout(tick, TOKEN_INTERVAL);
    };

    timer = setTimeout(tick, fromSeq === 0 ? FIRST_TOKEN_DELAY : 50);
  });
}

/**
 * 启动模拟 Agent。幂等：重复调用直接复用已监听的 server。
 * 端口被占用时只告警，不抛错（多 worker 场景下只会有一个成功监听）。
 */
function start(port = 7002) {
  if (server) return server;
  currentPort = Number(port) || 7002;

  server = http.createServer(handleStream);
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[mock-agent] port ${currentPort} already in use, reuse existing service`);
      server = null;
      return;
    }
    console.error('[mock-agent] server error:', err);
    server = null;
  });

  server.listen(currentPort, '127.0.0.1', () => {
    console.log(`[mock-agent] listening on http://127.0.0.1:${currentPort}/agent/stream`);
  });

  return server;
}

function getUrl() {
  return `http://127.0.0.1:${currentPort || 7002}/agent/stream`;
}

module.exports = { start, getUrl };
