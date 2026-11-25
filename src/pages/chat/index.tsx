import { useEffect, useRef, useState } from 'react';

import styles from './index.module.scss';
import AppNav from '@/components/AppNaviagtor';
import {
  StreamInterrupted,
  isAbortError,
  streamChat,
  type ChatEvent,
} from '@/lib/sse-chat';

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
 * 两种故障可分别观察：
 * - 浏览器断网（A）：Egg 缓冲回放，前端自动重连
 * - 上游断连（B）：Egg 自己向 Agent 续传，浏览器这侧无感
 */
export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('把性能优化的思路讲一下');
  const [failureMode, setFailureMode] = useState<FailureMode>('none');
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState('');

  const controllerRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const turnIdRef = useRef('');
  const lastRequestRef = useRef<{ message: string; assistantId: number } | null>(null);
  // 最后已处理的事件序号，重试时作为 Last-Event-ID 发出
  const cursorRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const busy = phase !== 'idle';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [ messages ]);

  // 组件卸载时中断在途请求
  useEffect(() => () => {
    controllerRef.current?.abort();
  }, []);

  function appendDelta(id: number, delta: string) {
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
            appendDelta(assistantId, event.content);
            setPhase(prev => prev === 'connecting' || prev === 'retrying' ? 'streaming' : prev);
          }
        },
      });

      patchMessage(assistantId, { status: 'done' });
      setPhase('idle');
      setNotice('');
    } catch (err) {
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
    setMessages([]);
    setPhase('idle');
    setNotice('');
    lastRequestRef.current = null;
    turnIdRef.current = '';
    cursorRef.current = 0;
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
        {notice ? <span className={styles.notice}>{notice}</span> : null}
        <button type="button" className={styles.ghost} onClick={clear} disabled={busy}>
          清空
        </button>
      </div>

      <div className={styles.messages}>
        {messages.length === 0 ? (
          <div className={styles.empty}>
            输入问题后回答逐字出现。可切换故障模式，观察浏览器断网与上游断连两种恢复路径。
          </div>
        ) : null}

        {messages.map(message => (
          <div
            key={message.id}
            className={`${styles.row} ${message.role === 'user' ? styles.userRow : styles.aiRow}`}
          >
            <div className={styles.avatar}>
              {message.role === 'user' ? '你' : 'AI'}
            </div>
            <div className={`${styles.bubble} ${message.role === 'user' ? styles.userBubble : styles.aiBubble}`}>
              <span className={styles.content}>{message.content}</span>
              {message.status === 'streaming' || message.status === 'retrying' ? <span className={styles.cursor} /> : null}
              {message.status === 'stopped' ? <span className={styles.tag}>已停止</span> : null}
              {message.status === 'error' ? <span className={styles.tagError}>失败</span> : null}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
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
        实现要点：浏览器生成 turnId → fetch POST + Last-Event-ID → Egg 按 seq 回放缓冲并接回实时流 →
        Egg 自己用 fetch 代理独立 Agent 服务（7002 端口）。取消走 AbortController，网络错误做指数退避。
        本地可在 /__chat/turns 查看每个 turn 的事件数与上游状态。
      </p>
    </div>
  );
}
