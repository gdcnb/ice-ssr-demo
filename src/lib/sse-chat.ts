/**
 * fetch + ReadableStream 消费 SSE 的通用封装（代理版）。
 *
 * 与旧版最大的区别：断点不再是「已收到多少个字符」，而是 SSE 的 id: 序号。
 * 每条事件都带 seq，重连时用 Last-Event-ID 告诉 Egg 从哪里补发。
 *
 * 这样可以同时处理两种断连：
 * - 浏览器 <-> Egg 断开：Egg 从 turn 缓冲回放 seq > cursor 的事件
 * - Egg <-> Agent 断开：Egg 自己带 lastSeq 续传上游，浏览器侧无感
 */

export type ChatEvent =
  | { type: 'start'; seq: number; turnId: string; total: number }
  | { type: 'delta'; seq: number; content: string }
  | { type: 'done'; seq: number; total: number }
  | { type: 'error'; seq: number; message: string };

export type StreamOptions = {
  /** 一轮生成的唯一 id，重试时必须复用，否则会被当成新的一轮 */
  turnId: string;
  message: string;
  /** 已经处理完的最后一条事件 seq */
  cursor: number;
  /** 仅在首次请求注入：模拟浏览器到 Egg 之间断连 */
  failBrowser?: boolean;
  /** 仅在首次请求注入：模拟 Egg 到 Agent 之间断连 */
  failUpstream?: boolean;
  signal: AbortSignal;
  onEvent: (event: ChatEvent) => void;
};

/** 流式中断，携带已确认处理的事件 seq，供上层带游标重试 */
export class StreamInterrupted extends Error {
  cursor: number;
  constructor(message: string, cursor: number) {
    super(message);
    this.cursor = cursor;
  }
}

/** 用户主动取消（abort）单独标记，避免与网络错误混为一谈 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** 解析一帧 SSE：优先用标准 id: 行作为 seq，退而用 data 里的 seq 字段 */
function parseFrame(frame: string): ChatEvent | null {
  let id = '';
  let data = '';
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;

  try {
    const payload = JSON.parse(data) as ChatEvent;
    const fallbackSeq = Number((payload as { seq?: number }).seq);
    const idSeq = id === '' ? NaN : Number(id);
    const seq = Number.isFinite(idSeq) ? idSeq : fallbackSeq;
    if (!Number.isFinite(seq)) return null;
    return { ...payload, seq } as ChatEvent;
  } catch {
    // 坏帧跳过，不影响整个流
    return null;
  }
}

export async function streamChat(options: StreamOptions): Promise<void> {
  const { turnId, message, cursor, failBrowser, failUpstream, signal, onEvent } = options;

  let response: Response;
  try {
    response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // SSE 标准头：Egg 优先读它，body.cursor 作为兼容兜底
        'Last-Event-ID': String(cursor),
      },
      body: JSON.stringify({
        turnId,
        message,
        cursor,
        fail: Boolean(failBrowser),
        upstreamFail: Boolean(failUpstream),
      }),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new StreamInterrupted('连接失败', cursor);
  }

  if (!response.ok) throw new StreamInterrupted(`HTTP ${response.status}`, cursor);
  if (!response.body) throw new StreamInterrupted('浏览器不支持 ReadableStream', cursor);

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { stream: true });
  let buffer = '';
  let appliedCursor = cursor;
  let finished = false;
  let streamError = '';

  try {
    while (true) {
      let value: Uint8Array;
      try {
        const result = await reader.read();
        if (result.done) break;
        value = result.value;
      } catch (err) {
        if (isAbortError(err)) throw err;
        throw new StreamInterrupted('读取流中断', appliedCursor);
      }

      // stream:true 保证跨 chunk 的多字节字符（中文）不会被截断成乱码
      buffer += decoder.decode(value, { stream: true });

      // 一个 chunk 可能是半帧 / 一帧 / 多帧：尾段留在 buffer 等下一轮
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      for (const frame of frames) {
        // 取消后不再把残留帧写进 UI（在途 chunk 可能已进入 buffer）
        if (signal.aborted) break;

        const event = parseFrame(frame);
        if (!event) continue;

        // 回放与实时流可能重叠；只处理还没确认过的事件
        if (event.seq <= appliedCursor) continue;
        appliedCursor = event.seq;

        if (event.type === 'done') finished = true;
        if (event.type === 'error') streamError = event.message;
        onEvent(event);
        if (streamError) break;
      }
      if (streamError) break;
    }

    // 极少数情况下服务端没用空行收尾，尝试解析残留帧
    if (!streamError && !signal.aborted && buffer.trim()) {
      const event = parseFrame(buffer);
      if (event && event.seq > appliedCursor) {
        appliedCursor = event.seq;
        if (event.type === 'done') finished = true;
        if (event.type === 'error') streamError = event.message;
        onEvent(event);
      }
    }

    if (streamError) throw new StreamInterrupted(streamError, appliedCursor);
    // 服务端异常断开时收不到 done 事件，按中断处理并带上准确游标
    if (!finished && !signal.aborted) throw new StreamInterrupted('响应提前结束', appliedCursor);
  } finally {
    reader.releaseLock();
  }
}
