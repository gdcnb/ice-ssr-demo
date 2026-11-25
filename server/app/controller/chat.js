'use strict';

const { Controller } = require('egg');

/**
 * AI Agent 流式代理入口。
 *
 * 控制器本身很薄：所有「turn 缓冲 / 断点回放 / 两侧断连恢复」都在
 * server/lib/chat-proxy.js。这里只把原生 req/res 交给代理层。
 *
 * 请求体：
 *   { turnId, message, cursor, fail, upstreamFail }
 * 请求头：
 *   Last-Event-ID: <seq>   （SSE 标准，优先级高于 body.cursor）
 *
 * fail         : 模拟浏览器 <-> Egg 断连（A），Egg 缓冲补发
 * upstreamFail : 模拟 Egg <-> Agent 断连（B），Egg 自动向上游续传
 */
module.exports = class ChatController extends Controller {
  async stream() {
    await this.app.chatProxy.handle(this.ctx);
  }
};
