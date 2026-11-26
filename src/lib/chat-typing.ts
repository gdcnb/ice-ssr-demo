/**
 * 打字节奏控制：把网络层到来的字符放进队列，按时间片提交给 React。
 *
 * 目的不是「越快越好」：原始 ReadableStream chunk 直接 setState 会爆闪，
 * 代码块/表格/公式每次重渲染成本也更高。这里按内容类型给不同节奏：
 *
 * - 普通文本：24ms 一批，最多 3 个字符
 * - 表格：    34ms 一批，最多 2 个字符
 * - 公式：    40ms 一批，最多 2 个字符
 * - 代码：    48ms 一批，每次 1 个字符（给语法高亮留出稳定帧）
 *
 * 队列只负责节奏，不负责 SSE 解析；SSE 的 seq 去重仍由 sse-chat.ts 处理。
 */

export type SegmentKind = 'text' | 'table' | 'formula' | 'code';

export type Pace = {
  interval: number;
  batch: number;
  label: string;
};

export const PACE: Record<SegmentKind, Pace> = {
  text: { interval: 24, batch: 3, label: '文本' },
  table: { interval: 34, batch: 2, label: '表格' },
  formula: { interval: 40, batch: 2, label: '公式' },
  code: { interval: 48, batch: 1, label: '代码' },
};

const CODE_FENCE = /```/g;
const CODE_HINT = /^\s*(def |function |const |let |var |class |import |from |#include|<\/?[A-Za-z])|^\s*\{\s*$/m;
const FORMULA_HINT = /\$|\\\(|\\\[|\\begin\{|\\frac|\\sum|\\int/;
const TABLE_HINT = /^\s*\|.*\|\s*$|^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+$/m;

function countFences(text: string): number {
  const matches = text.match(CODE_FENCE);
  return matches ? matches.length : 0;
}

export class TypingQueue {
  private pending = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlush = 0;
  private inCode = false;

  constructor(private onCommit: (text: string, kind: SegmentKind) => void) {}

  /**
   * 判断即将输出的内容属于哪种类型。
   * mutate=true 时同步代码块状态（只在真正提交时调用，避免预读改变状态）。
   */
  private classify(text: string, mutate: boolean): SegmentKind {
    const fences = countFences(text);
    const inCode = mutate && fences % 2 === 1 ? !this.inCode : this.inCode;
    if (mutate) this.inCode = inCode;

    if (inCode || fences > 0 || CODE_HINT.test(text)) return 'code';
    if (FORMULA_HINT.test(text)) return 'formula';
    if (TABLE_HINT.test(text)) return 'table';
    return 'text';
  }

  /** 预读队首，决定下一个时间片用哪种节奏 */
  private peekKind(): SegmentKind {
    const sample = Array.from(this.pending).slice(0, PACE.text.batch).join('');
    return this.classify(sample, false);
  }

  private clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule() {
    if (this.timer !== null || !this.pending) return;

    const pace = PACE[this.peekKind()];
    const elapsed = performance.now() - this.lastFlush;
    const delay = Math.max(0, pace.interval - elapsed);

    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
  }

  private flush() {
    if (!this.pending) return;

    const pace = PACE[this.peekKind()];
    const chars = Array.from(this.pending); // 按 Unicode 字符切，避免拆散 emoji
    const take = chars.slice(0, pace.batch).join('');
    this.pending = chars.slice(pace.batch).join('');

    const kind = this.classify(take, true);
    this.lastFlush = performance.now();
    this.onCommit(take, kind);

    if (this.pending) this.schedule();
  }

  /** 网络帧到达：只入队，不直接触发 UI 更新 */
  push(delta: string) {
    if (!delta) return;
    this.pending += delta;
    this.schedule();
  }

  /** 流正常结束或主动取消：把剩余字符一次性补齐，避免丢字 */
  flushAll() {
    this.clearTimer();
    if (!this.pending) return;

    const take = this.pending;
    this.pending = '';
    const kind = this.classify(take, true);
    this.lastFlush = performance.now();
    this.onCommit(take, kind);
  }

  /** 清空（换一轮 / 清空会话）：丢弃还没输出的字符 */
  reset() {
    this.clearTimer();
    this.pending = '';
    this.lastFlush = 0;
    this.inCode = false;
  }
}
