'use strict';

/**
 * Egg <-> Agent 的 SSE 代理层。
 *
 * 浏览器到 Egg 的断连（A）与 Egg 到 Agent 的断连（B）分别处理：
 *
 * - 每个 turnId 维护一份事件缓冲 events[]，seq 单调递增。
 * - 浏览器重连时带 Last-Event-ID / body.cursor，代理只回放 seq > cursor 的事件，
 *   再把新响应挂到 subscribers 上继续接实时流。
 * - 浏览器断开不立刻 abort 上游，留一个宽限期给重连；宽限期结束才停上游。
 * - 上游断开时，代理带自己收到的 lastSeq 作为 Last-Event-ID 重连 Agent，
 *   浏览器侧的无须任何感知。
 *
 * 生产环境多实例时，把 events[] 换成 Redis Stream / List（带 TTL）即可，
 * 协议层（turnId + seq）不需要改。
 */

const DEFAULTS = {
  agentUrl: 'http://127.0.0.1:7002/agent/stream',
  turnTtl: 10 * 60 * 1000,
  graceMs: 60 * 1000,
  heartbeatMs: 15 * 1000,
  reconnectDelay: 300,
};

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return NaN;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

function sseFrame(event) {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** 解析上游的一帧 SSE，取出 id: 与 data: */
function parseSSEFrame(frame) {
  let id = '';
  let data = '';
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    const payload = JSON.parse(data);
    const seq = toFiniteNumber(id);
    if (!Number.isFinite(seq) || !payload || typeof payload !== 'object') return null;
    return { seq, event: { ...payload, seq } };
  } catch (_) {
    return null;
  }
}

class ChatProxy {
  constructor(app) {
    this.app = app;
    this.config = { ...DEFAULTS, ...(app.config.chatProxy || {}) };
    this.turns = new Map();
  }

  ensure(turnId) {
    let state = this.turns.get(turnId);
    if (state) return state;

    state = {
      turnId,
      events: [],
      lastSeq: 0,
      status: 'running',
      subscribers: new Set(),
      upstreamAbort: null,
      upstreamRunning: false,
      upstreamPending: false,
      upstreamRetried: false,
      reconnectTimer: null,
      graceTimer: null,
      expireTimer: null,
      browserFailureConfigured: false,
      upstreamFailureConfigured: false,
      injectBrowserFail: false,
      injectUpstreamFail: false,
      browserFailAtSeq: null,
    };
    this.turns.set(turnId, state);
    this.scheduleExpire(turnId);
    return state;
  }

  scheduleExpire(turnId) {
    const state = this.turns.get(turnId);
    if (!state) return;
    clearTimeout(state.expireTimer);
    state.expireTimer = setTimeout(() => this.destroy(turnId), this.config.turnTtl);
    if (typeof state.expireTimer.unref === 'function') state.expireTimer.unref();
  }

  destroy(turnId) {
    const state = this.turns.get(turnId);
    if (!state) return;
    clearTimeout(state.expireTimer);
    clearTimeout(state.graceTimer);
    clearTimeout(state.reconnectTimer);
    try {
      state.upstreamAbort?.abort();
    } catch (_) {
      // 上游可能已经结束
    }
    for (const res of state.subscribers) {
      try {
        res.end();
      } catch (_) {
        // 连接已断开
      }
    }
    state.subscribers.clear();
    this.turns.delete(turnId);
    this.app.coreLogger.info('[chat-proxy] turn=%s expired and removed', turnId);
  }

  broadcast(state, event) {
    const frame = sseFrame(event);
    for (const res of [ ...state.subscribers ]) {
      try {
        res.write(frame);
      } catch (_) {
        state.subscribers.delete(res);
      }
    }
  }

  /** 终态事件写完后关闭所有浏览器响应，否则 SSE 连接会一直挂着 */
  finishSubscribers(state) {
    for (const res of [ ...state.subscribers ]) {
      try {
        res.end();
      } catch (_) {
        // ignore
      }
      state.subscribers.delete(res);
    }
  }

  append(state, event) {
    if (!event || !Number.isFinite(event.seq) || event.seq <= state.lastSeq) return;

    state.events.push(event);
    state.lastSeq = event.seq;
    if (event.type === 'done') state.status = 'done';
    if (event.type === 'error') state.status = 'failed';

    // 浏览器断网故障点：按 start 事件里的 total 算出 40% 处的 delta seq
    if (event.type === 'start' && state.injectBrowserFail && state.browserFailAtSeq === null) {
      state.browserFailAtSeq = Math.max(2, Math.floor((event.total || 0) * 0.4) + 1);
    }

    this.broadcast(state, event);

    if (state.injectBrowserFail && state.browserFailAtSeq !== null && event.seq >= state.browserFailAtSeq) {
      state.injectBrowserFail = false;
      this.app.coreLogger.warn(
        '[chat-proxy] turn=%s simulate browser disconnect at seq=%d',
        state.turnId,
        event.seq
      );
      for (const res of [ ...state.subscribers ]) {
        try {
          res.destroy();
        } catch (_) {
          try {
            res.end();
          } catch (_) {
            // ignore
          }
        }
      }
      state.subscribers.clear();
    }

    if (state.status === 'done' || state.status === 'failed') {
      this.finishSubscribers(state);
    }

    this.scheduleExpire(state.turnId);
  }

  /** 浏览器断开后，给重连留一个宽限期再停上游 */
  scheduleGraceAbort(state) {
    clearTimeout(state.graceTimer);
    state.graceTimer = setTimeout(() => {
      state.graceTimer = null;
      if (state.subscribers.size || state.status !== 'running') return;

      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
        state.upstreamPending = false;
      }
      try {
        state.upstreamAbort?.abort();
      } catch (_) {
        // ignore
      }
      this.app.coreLogger.info('[chat-proxy] turn=%s no subscriber, upstream aborted', state.turnId);
    }, this.config.graceMs);
    if (typeof state.graceTimer.unref === 'function') state.graceTimer.unref();
  }

  /** Agent 断开：带代理侧 lastSeq 续传一次；再断就显式告诉前端失败 */
  scheduleUpstreamRetry(state, message, reason) {
    if (state.status === 'done' || state.status === 'failed') return;

    if (state.upstreamRetried) {
      this.append(state, {
        seq: state.lastSeq + 1,
        type: 'error',
        message: '上游连续中断，请稍后重试',
      });
      return;
    }

    state.upstreamRetried = true;
    state.upstreamPending = true;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      state.upstreamPending = false;
      this.app.coreLogger.warn(
        '[chat-proxy] turn=%s reconnect upstream from seq=%d (%s)',
        state.turnId,
        state.lastSeq,
        reason
      );
      this.connectUpstream(state, message, state.lastSeq, false);
    }, this.config.reconnectDelay);
    if (typeof state.reconnectTimer.unref === 'function') state.reconnectTimer.unref();
  }

  async connectUpstream(state, message, fromSeq, injectFail) {
    if (state.status === 'done' || state.status === 'failed') return;

    state.upstreamRunning = true;
    state.upstreamPending = false;
    // 故障注入只消费一次：代理自动重试或浏览器重连都不再重复注入
    state.injectUpstreamFail = false;
    const controller = new AbortController();
    state.upstreamAbort = controller;

    let reader = null;
    try {
      const response = await fetch(this.config.agentUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Last-Event-ID': String(fromSeq),
        },
        body: JSON.stringify({
          turnId: state.turnId,
          message,
          fromSeq,
          fail: injectFail,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`agent responded ${response.status}`);
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let streamEnded = false;

      while (true) {
        const result = await reader.read();
        if (result.done) {
          streamEnded = true;
          break;
        }

        buffer += decoder.decode(result.value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';

        for (const frame of frames) {
          const parsed = parseSSEFrame(frame);
          if (parsed) this.append(state, parsed.event);
        }
      }

      // 尾部可能还有一帧没有以空行结束
      if (buffer.trim()) {
        const parsed = parseSSEFrame(buffer);
        if (parsed) this.append(state, parsed.event);
      }

      if (streamEnded && state.status !== 'done' && state.status !== 'failed') {
        this.scheduleUpstreamRetry(state, message, 'stream ended before done');
      }
    } catch (err) {
      if (controller.signal.aborted) {
        this.app.coreLogger.info('[chat-proxy] turn=%s upstream aborted by grace timer', state.turnId);
      } else {
        this.scheduleUpstreamRetry(state, message, err.message || 'fetch error');
      }
    } finally {
      try {
        reader?.releaseLock();
      } catch (_) {
        // ignore
      }
      state.upstreamRunning = false;
      if (state.status === 'done' || state.status === 'failed') this.scheduleExpire(state.turnId);
    }
  }

  async handle(ctx) {
    const { req, res } = ctx;
    const body = ctx.request.body || {};
    const turnId = String(body.turnId || ctx.get('x-turn-id') || '').trim();

    if (!turnId) {
      ctx.status = 400;
      ctx.body = { error: 'turnId is required' };
      return;
    }

    const headerCursor = toFiniteNumber(ctx.get('last-event-id'));
    const bodyCursor = toFiniteNumber(body.cursor);
    const cursor = Math.max(0, Number.isFinite(headerCursor) ? headerCursor : (Number.isFinite(bodyCursor) ? bodyCursor : 0));
    const message = String(body.message || '');

    ctx.respond = false;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (req.socket) {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
    }
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const state = this.ensure(turnId);
    state.subscribers.add(res);
    clearTimeout(state.graceTimer);
    state.graceTimer = null;

    // 故障注入只在第一次请求生效；重试时不再注入，避免死循环
    if (body.fail && !state.browserFailureConfigured) {
      state.browserFailureConfigured = true;
      state.injectBrowserFail = true;
    }
    if (body.upstreamFail && !state.upstreamFailureConfigured) {
      state.upstreamFailureConfigured = true;
      state.injectUpstreamFail = true;
    }

    // 断点回放：只补发浏览器还没确认的事件
    for (const event of state.events) {
      if (event.seq <= cursor) continue;
      try {
        res.write(sseFrame(event));
      } catch (_) {
        state.subscribers.delete(res);
        break;
      }
    }

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        clearInterval(heartbeat);
      }
    }, this.config.heartbeatMs);

    const cleanup = () => {
      clearInterval(heartbeat);
      state.subscribers.delete(res);
      if (!state.subscribers.size && state.status === 'running') {
        this.scheduleGraceAbort(state);
      }
    };
    res.on('close', cleanup);
    req.on('aborted', cleanup);

    if (!state.upstreamRunning && !state.upstreamPending && state.status === 'running') {
      this.connectUpstream(state, message, state.lastSeq, state.injectUpstreamFail).catch(err => {
        this.app.coreLogger.error('[chat-proxy] upstream error: %s', err.stack || err.message);
      });
    }
  }

  stats() {
    return [ ...this.turns.values() ].map(state => ({
      turnId: state.turnId,
      status: state.status,
      lastSeq: state.lastSeq,
      eventCount: state.events.length,
      subscribers: state.subscribers.size,
      upstreamRunning: state.upstreamRunning,
      upstreamPending: state.upstreamPending,
      upstreamRetried: state.upstreamRetried,
    }));
  }
}

module.exports = ChatProxy;
