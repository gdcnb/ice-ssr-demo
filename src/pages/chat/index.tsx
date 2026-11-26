import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from 'react';

import styles from './index.module.scss';
import AppNav from '@/components/AppNaviagtor';
import {
  StreamInterrupted,
  isAbortError,
  streamChat,
  type ChatEvent,
} from '@/lib/sse-chat';
import { PACE, TypingQueue, type SegmentKind } from '@/lib/chat-typing';

type MessageStatus = 'done' | 'streaming' | 'retrying' | 'error' | 'stopped';
type Message = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
};
type Phase = 'idle' | 'connecting' | 'streaming' | 'retrying' | 'error';
type FailureMode = 'none' | 'browser' | 'upstream';

const MAX_AUTO_RETRY = 2;
const BOTTOM_EPS = 24; // 允许 24px 误差仍视为「贴底」
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function createTurnId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 模拟 AI Agent 对话页（Egg 代理版）。
 *
 * 一轮生成由 turnId 标识；断线重试必须复用它，否则会被当成新一轮。
 * 游标是 SSE 的 id: 序号（事件 seq），不是字符数。
 *
 * 交互侧三件事：
 * - 网络帧进 TypingQueue，按内容类型分时间片输出，不直接刷屏
 * - 只在用户已经贴底时自动滚动；上翻看历史时保持视口位置
 * - 滚动读取全部收进 rAF，每帧最多读一次 scrollTop/scrollHeight
 */
export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('把性能优化的思路讲一下');
  const [failureMode, setFailureMode] = useState<FailureMode>('none');
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState('');
  const [paceKind, setPaceKind] = useState<SegmentKind>('text');
  const [paused, setPaused] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const turnIdRef = useRef('');
  const lastRequestRef = useRef<{ message: string; assistantId: number } | null>(null);
  // 最后已处理的事件序号，重试时作为 Last-Event-ID 发出
  const cursorRef = useRef(0);
  const typingRef = useRef<TypingQueue | null>(null);

  // 滚动策略相关 ref：所有 scrollTop / scrollHeight 读写都合并到一次 rAF
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(true);
  const anchorPendingRef = useRef(false);
  const needsReconcileRef = useRef(false);
  const scrollRafRef = useRef(0);
  const metricsRef = useRef({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });

  // 打字光标定位：每帧最多读一次布局，再用 transform 写回
  const activeBubbleRef = useRef<HTMLDivElement | null>(null);
  const activeContentRef = useRef<HTMLSpanElement | null>(null);
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const caretRafRef = useRef(0);

  const busy = phase !== 'idle';
  const activeAssistantId = lastRequestRef.current?.assistantId;

  /** 更新「是否贴底」，状态变化时同步一个轻量的暂停标记 */
  const setStickBottom = useCallback((value: boolean) => {
    if (stickBottomRef.current === value) return;
    stickBottomRef.current = value;
    setPaused(!value);
  }, []);

  /** 把滚动相关的读取/写入合并到同一个 rAF，避免 Layout Thrashing */
  const scheduleScroll = useCallback((reconcile = false) => {
    if (reconcile) needsReconcileRef.current = true;
    if (scrollRafRef.current || typeof requestAnimationFrame !== 'function') return;

    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const el = messagesRef.current;
      if (!el) return;

      // 一帧内只读一次这几个属性
      const top = el.scrollTop;
      const height = el.scrollHeight;
      const client = el.clientHeight;
      const shouldReconcile = needsReconcileRef.current;
      needsReconcileRef.current = false;

      let nextTop = top;
      if (shouldReconcile) {
        if (anchorPendingRef.current) {
          // 用户在看历史：内容追加在下方，保持当前视口位置不动
          nextTop = metricsRef.current.scrollTop;
          anchorPendingRef.current = false;
        } else if (stickBottomRef.current) {
          // 用户本来就在底部：新内容到达后继续贴底
          nextTop = height;
        }
        if (nextTop !== top) el.scrollTop = nextTop;
      } else {
        // 用户滚动事件：更新贴底判断，不做任何写入
        setStickBottom(top + client >= height - BOTTOM_EPS);
      }

      metricsRef.current = {
        scrollTop: nextTop,
        scrollHeight: height,
        clientHeight: client,
      };
    });
  }, [ setStickBottom ]);

  /** 任何会让内容变高的更新之前调用：上翻状态下标记需要锚定 */
  function markBeforeContentChange() {
    if (!stickBottomRef.current) anchorPendingRef.current = true;
  }

  function jumpToBottom() {
    anchorPendingRef.current = false;
    setStickBottom(true);
    scheduleScroll(true);
  }

  const handleScroll = useCallback(() => {
    scheduleScroll(false);
  }, [ scheduleScroll ]);

  // wheel / touch 向上时立刻暂停，不等 scroll 事件的 rAF，避免被新字符抢先滚到底
  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) setStickBottom(false);
  }, [ setStickBottom ]);
  const handleTouchMove = useCallback(() => setStickBottom(false), [ setStickBottom ]);

  /** 把绝对定位的光标挪到当前文本末尾，每帧最多排一次 */
  const scheduleCaret = useCallback(() => {
    if (caretRafRef.current || typeof requestAnimationFrame !== 'function') return;
    caretRafRef.current = requestAnimationFrame(() => {
      caretRafRef.current = 0;
      const bubble = activeBubbleRef.current;
      const content = activeContentRef.current;
      const caret = caretRef.current;
      if (!bubble || !content || !caret) return;

      // 读操作集中在这里，且每帧只做一次；写操作只用 transform
      const range = document.createRange();
      range.selectNodeContents(content);
      range.collapse(false);
      const textRect = range.getBoundingClientRect();
      const bubbleRect = bubble.getBoundingClientRect();
      const x = Math.round(textRect.left - bubbleRect.left - bubble.clientLeft);
      const y = Math.round(textRect.top - bubbleRect.top - bubble.clientTop);

      caret.style.height = `${Math.max(14, Math.round(textRect.height || 16))}px`;
      caret.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    });
  }, []);

  useEffect(() => {
    // 首次测量容器尺寸，后续都复用缓存值
    scheduleScroll(false);
  }, [ scheduleScroll ]);

  // 每次文字提交后重排光标与滚动位置；React 已提交 DOM，rAF 里读取布局不与写入交错
  useEffect(() => {
    scheduleCaret();
    scheduleScroll(true);
  }, [ messages, scheduleCaret, scheduleScroll ]);

  const handleResize = useCallback(() => {
    scheduleCaret();
    scheduleScroll(false);
  }, [ scheduleCaret, scheduleScroll ]);

  useEffect(() => {
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (caretRafRef.current) cancelAnimationFrame(caretRafRef.current);
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, [ handleResize ]);

  // 组件卸载时中断在途请求并丢弃未输出字符
  useEffect(() => () => {
    controllerRef.current?.abort();
    typingRef.current?.reset();
  }, []);

  function appendDelta(id: number, delta: string) {
    markBeforeContentChange();
    setMessages(prev => prev.map(m =>
      m.id === id ? { ...m, content: m.content + delta } : m
    ));
  }

  function patchMessage(id: number, patch: Partial<Message>) {
    setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)));
  }

  async function runStream(
    message: string,
    assistantId: number,
    offset: number,
    mode: FailureMode,
    retryCount: number
  ) {
    const controller = new AbortController();
    controllerRef.current = controller;
    const firstAttempt = retryCount === 0;

    // 每一轮（含重试）用新的打字队列；网络帧只入队，不直接 setState
    const queue = new TypingQueue((text, kind) => {
      appendDelta(assistantId, text);
      setPaceKind(prev => (prev === kind ? prev : kind));
      scheduleCaret();
    });
    typingRef.current = queue;

    setPhase(firstAttempt ? 'connecting' : 'retrying');
    setNotice(retryCount > 0
      ? `连接中断，第 ${retryCount} 次重连（从事件 #${offset} 继续）…`
      : mode === 'upstream'
        ? '已注入上游断连：Egg 会自动带 Last-Event-ID 向 Agent 续传，本页连接不断开'
        : '');
    patchMessage(assistantId, { status: firstAttempt ? 'streaming' : 'retrying' });

    try {
      await streamChat({
        turnId: turnIdRef.current,
        message,
        cursor: offset,
        failBrowser: firstAttempt && mode === 'browser',
        failUpstream: firstAttempt && mode === 'upstream',
        signal: controller.signal,
        onEvent: (event: ChatEvent) => {
          // 回放可能与实时流重叠，按 seq 再去重一层
          if (event.seq <= cursorRef.current) return;
          cursorRef.current = event.seq;

          if (event.type === 'delta') {
            // 只入队；实际渲染由时间片控制
            queue.push(event.content);
            setPhase(prev => (prev === 'connecting' || prev === 'retrying' ? 'streaming' : prev));
          }
        },
      });

      // 正常结束：把时间片里还没吐完的字符补齐，再标记 done
      queue.flushAll();
      patchMessage(assistantId, { status: 'done' });
      setPhase('idle');
      setNotice('');
    } catch (err) {
      // 异常/取消：已收到的字符不应丢失，先补完再处理状态
      queue.flushAll();

      if (isAbortError(err)) {
        patchMessage(assistantId, { status: 'stopped' });
        setPhase('idle');
        setNotice('已停止生成');
        return;
      }

      const cursor = err instanceof StreamInterrupted ? err.cursor : offset;
      cursorRef.current = cursor;

      // 上游连续中断时重开浏览器连接也没用，直接把错误暴露出来
      const upstreamDead = err instanceof StreamInterrupted && err.message.includes('上游');

      // 网络错误：指数退避自动重试，复用同一个 turnId + 新游标
      if (retryCount < MAX_AUTO_RETRY && !upstreamDead) {
        patchMessage(assistantId, { status: 'retrying' });
        await wait(400 * (retryCount + 1));
        if (controller.signal.aborted) {
          patchMessage(assistantId, { status: 'stopped' });
          setPhase('idle');
          setNotice('已停止生成');
          return;
        }
        return runStream(message, assistantId, cursor, 'none', retryCount + 1);
      }

      patchMessage(assistantId, { status: 'error' });
      setPhase('error');
      setNotice(err instanceof Error ? err.message : '未知错误');
    } finally {
      if (typingRef.current === queue) typingRef.current = null;
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function send() {
    const text = input.trim();
    if (!text || busy) return;

    const userId = ++idRef.current;
    const assistantId = ++idRef.current;
    turnIdRef.current = createTurnId();
    cursorRef.current = 0;
    typingRef.current?.reset();
    setPaceKind('text');
    markBeforeContentChange();

    setMessages(prev => [
      ...prev,
      { id: userId, role: 'user', content: text, status: 'done' },
      { id: assistantId, role: 'assistant', content: '', status: 'streaming' },
    ]);
    setInput('');
    lastRequestRef.current = { message: text, assistantId };
    runStream(text, assistantId, 0, failureMode, 0);
  }

  function stop() {
    controllerRef.current?.abort();
    setPhase('idle');
    setNotice('已停止生成');
  }

  function retry() {
    const request = lastRequestRef.current;
    if (!request || busy || !turnIdRef.current) return;
    runStream(request.message, request.assistantId, cursorRef.current, 'none', 0);
  }

  function clear() {
    controllerRef.current?.abort();
    typingRef.current?.reset();
    typingRef.current = null;
    setMessages([]);
    setPhase('idle');
    setNotice('');
    setPaceKind('text');
    lastRequestRef.current = null;
    turnIdRef.current = '';
    cursorRef.current = 0;
    anchorPendingRef.current = false;
    stickBottomRef.current = true;
    setPaused(false);
  }

  const statusText: Record<Phase, string> = {
    idle: '就绪',
    connecting: '连接中…',
    streaming: '生成中…',
    retrying: '恢复中…',
    error: '连接失败',
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>AI Agent Chat · Egg 代理版流式演示</h1>
      </header>
      <AppNav />

      <div className={styles.toolbar}>
        <span className={`${styles.phase} ${styles[phase]}`}>{statusText[phase]}</span>
        {busy ? (
          <span className={styles.pace}>
            {PACE[paceKind].label} · {PACE[paceKind].interval}ms/片 · {PACE[paceKind].batch} 字
          </span>
        ) : null}
        {notice ? <span className={styles.notice}>{notice}</span> : null}
        <button type="button" className={styles.ghost} onClick={clear} disabled={busy}>
          清空
        </button>
      </div>

      <div
        ref={messagesRef}
        className={styles.messages}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchMove={handleTouchMove}
      >
        {messages.length === 0 ? (
          <div className={styles.empty}>
            输入问题后回答逐字出现。可切换故障模式，观察浏览器断网与上游断连两种恢复路径。
          </div>
        ) : null}

        {messages.map(message => {
          const isTyping = message.role === 'assistant'
            && message.id === activeAssistantId
            && (message.status === 'streaming' || message.status === 'retrying');

          return (
            <div
              key={message.id}
              className={`${styles.row} ${message.role === 'user' ? styles.userRow : styles.aiRow}`}
            >
              <div className={styles.avatar}>
                {message.role === 'user' ? '你' : 'AI'}
              </div>
              <div
                ref={isTyping ? activeBubbleRef : undefined}
                className={`${styles.bubble} ${message.role === 'user' ? styles.userBubble : styles.aiBubble}`}
              >
                <span
                  ref={isTyping ? activeContentRef : undefined}
                  className={styles.content}
                >
                  {message.content}
                </span>
                {isTyping ? <span ref={caretRef} className={styles.caret} aria-hidden="true" /> : null}
                {message.status === 'stopped' ? <span className={styles.tag}>已停止</span> : null}
                {message.status === 'error' ? <span className={styles.tagError}>失败</span> : null}
              </div>
            </div>
          );
        })}

        {paused ? (
          <button type="button" className={styles.jumpBottom} onClick={jumpToBottom}>
            已暂停自动滚动 · 回到底部
          </button>
        ) : null}
      </div>

      <div className={styles.composer}>
        <textarea
          className={styles.input}
          value={input}
          rows={2}
          placeholder="输入问题，例如：把性能优化的思路讲一下"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className={styles.actions}>
          <label className={styles.checkbox}>
            故障模式
            <select
              className={styles.select}
              value={failureMode}
              onChange={e => setFailureMode(e.target.value as FailureMode)}
              disabled={busy}
            >
              <option value="none">不模拟</option>
              <option value="browser">浏览器断网（A）</option>
              <option value="upstream">上游断连（B）</option>
            </select>
          </label>
          {busy ? (
            <button type="button" className={styles.stop} onClick={stop}>停止生成</button>
          ) : (
            <button type="button" className={styles.send} onClick={send} disabled={!input.trim()}>
              发送
            </button>
          )}
          {phase === 'error' ? (
            <button type="button" className={styles.retry} onClick={retry}>重试</button>
          ) : null}
        </div>
      </div>

      <p className={styles.hint}>
        实现要点：网络帧按文本/表格/公式/代码分时间片输出；只有贴底时才自动滚动，
        上翻时保持视口并用 rAF 合并滚动读写；长消息完整展开，由消息区统一滚动；
        打字光标在 rAF 里定位。Egg 侧仍用 turnId + Last-Event-ID 做断点回放。
      </p>
    </div>
  );
}
