'use strict';

/**
 * AI Agent 的固定语料。
 *
 * 模拟 Agent 服务与 Egg 代理共用同一份语料，方便对比：
 * 同一个 turnId 无论续传多少次，生成的全文都稳定一致。
 * 真实场景里这份「确定性」由上游模型服务自己的事件日志提供。
 */

const REPLIES = {
  default:
    '你好，我是模拟的 AI Agent。我会在你输入后逐字返回内容，你可以在浏览器里看到文字一个一个出现。' +
    '这个效果来自服务端的 SSE 流式响应：后端把一句话拆成很多小块，每块立刻写出，前端用 fetch 拿到 ReadableStream 后边读边渲染。' +
    '如果中途连接断开，前端会带着 turnId 和最后处理的事件序号重连，Egg 代理从缓冲里补发缺失部分，不会从头再来。',
  perf:
    '关于性能优化，我建议按这个顺序排查：\n' +
    '1. 先测量，用 Performance 面板和火焰图定位真正的瓶颈，不要凭感觉优化。\n' +
    '2. 减少首屏资源：按路由拆 JS 和 CSS，只加载当前页面需要的部分。\n' +
    '3. 对服务端渲染做流式输出，异步数据就绪前先发首屏外壳，降低 TTFB。\n' +
    '4. 加缓存：HTML 缓存、静态资源强缓存、接口数据缓存，能复用就不重复计算。\n' +
    '5. 最后再考虑微优化，比如减少重渲染、虚拟长列表、图片懒加载。',
  code:
    '关于代码结构，我的建议是把「稳定层」和「易变层」分开：\n' +
    '框架、路由、布局这些长期不变的部分放在外层；业务页面和组件按域拆分，各自独立。\n' +
    '构建产物也按页分包，避免一次加载所有代码。\n' +
    '另外要给关键链路留观测点，比如缓存命中率、首字节耗时、流式分块数，这样优化才有依据。',
};

function pickReply(message) {
  const text = String(message || '');
  if (/性能|优化|TTFB|速度/.test(text)) return REPLIES.perf;
  if (/代码|结构|重构|架构/.test(text)) return REPLIES.code;
  return REPLIES.default;
}

module.exports = { REPLIES, pickReply };
