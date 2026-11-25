/**
 * ug 页流式演示用的延迟开关。
 *
 * 服务端每个请求开始时调用 beginDelayRequest(streaming) 重新计时；
 * 组件首次渲染时调用 suspendForDelay()，流式模式下挂起 3s，
 * 非流式（缓存刷新 / renderToString）与浏览器 hydrate 时直接返回。
 */

type DelayState = { status: 'pending' | 'resolved'; promise: Promise<void> };

let enabled = false;
let state: DelayState | undefined;

export function beginDelayRequest(streaming: boolean): void {
  if (typeof window !== 'undefined') return;
  enabled = streaming;
  state = undefined;
}

export function suspendForDelay(): void {
  // 客户端 hydrate 不做延迟，否则会与服务端已流出的内容不一致
  if (typeof window !== 'undefined' || !enabled) return;

  if (!state) {
    const next: DelayState = { status: 'pending', promise: Promise.resolve() };
    next.promise = new Promise<void>(resolve => {
      setTimeout(() => {
        next.status = 'resolved';
        resolve();
      }, 3000);
    });
    state = next;
  }

  if (state.status === 'pending') throw state.promise;
}
