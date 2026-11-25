'use strict';

/**
 * 轻量 HTML 缓存：LRU 容量淘汰 + TTL 过期 + stale-while-revalidate + 并发合并。
 *
 * 只缓存「渲染结果」(statusCode / headers / value)，不缓存 egg 自身的响应头。
 * 实例挂在 app 上，一个 egg worker 一份；多 worker 场景需换成 Redis 等共享存储。
 */
module.exports = class HtmlCache {
  constructor({ max = 500 } = {}) {
    this.max = max;
    // key -> { statusCode, headers, value, expiresAt, staleUntil, reqInfo }
    this.store = new Map();
    // key -> Promise，保证同一 key 同时只有一个渲染/刷新在跑
    this.pending = new Map();
    this.stats = { hit: 0, miss: 0, stale: 0, bypass: 0, refresh: 0 };
  }

  bump(name) {
    this.stats[name] = (this.stats[name] || 0) + 1;
  }

  /**
   * 读取缓存，返回 { state, entry }。
   * state: HIT(未过期) | STALE(过期但在 SWR 窗口内) | MISS
   */
  get(key, now = Date.now()) {
    const entry = this.store.get(key);
    if (!entry) return { state: 'MISS' };

    if (now < entry.expiresAt) {
      this.promote(key, entry);
      return { state: 'HIT', entry };
    }
    if (now < entry.staleUntil) {
      this.promote(key, entry);
      return { state: 'STALE', entry };
    }

    this.store.delete(key);
    return { state: 'MISS' };
  }

  set(key, response, rule, reqInfo) {
    const now = Date.now();
    const ttl = rule.ttl || 0;
    const swr = rule.staleWhileRevalidate || 0;
    const entry = {
      statusCode: response.statusCode,
      headers: { ...(response.headers || {}) },
      value: response.value,
      expiresAt: now + ttl,
      staleUntil: now + ttl + swr,
      reqInfo,
    };
    this.store.delete(key);
    this.store.set(key, entry);
    this.evict();
    return entry;
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    const count = this.store.size;
    this.store.clear();
    for (const key of this.pending.keys()) this.pending.delete(key);
    this.stats = { hit: 0, miss: 0, stale: 0, bypass: 0, refresh: 0 };
    return count;
  }

  promote(key, entry) {
    this.store.delete(key);
    this.store.set(key, entry);
  }

  evict() {
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
  }

  /** 同一 key 的并发请求共用一个 Promise，避免缓存击穿。 */
  singleflight(key, fn) {
    if (this.pending.has(key)) return this.pending.get(key);
    const task = Promise.resolve()
      .then(fn)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
};
