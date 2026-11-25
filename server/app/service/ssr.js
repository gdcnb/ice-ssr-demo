'use strict';

const { Service } = require('egg');

/**
 * SSR 渲染服务：在 webpack 渲染器前加一层按路由配置的 HTML 缓存。
 *
 * - 命中且未过期(HIT)：直接返回缓存的 Response，跳过 renderToHTML
 * - 过期但在 SWR 窗口内(STALE)：先返回旧 HTML，后台异步刷新（不阻塞用户）
 * - 未命中(MISS)：用 singleflight 合并并发请求，只渲染一次再写入缓存
 * - 未匹配缓存规则或响应非 200：BYPASS，实时渲染且不缓存
 *
 * 流式：当 config.ssr.stream 为 true 且非缓存命中时，走 renderStream，
 * 由渲染器产出 Readable 流边渲染边发送；渲染完成后把完整 HTML 写缓存。
 * 缓存命中(HIT/STALE)仍走整串发送，流式没有意义。
 */
module.exports = class SsrService extends Service {
  async render() {
    const { ctx, app } = this;
    const { header, enable, rules } = app.config.htmlCache;
    const cache = app.htmlCache;
    const streaming = app.config.ssr.stream && typeof app.ssrRenderer.renderToStream === 'function';

    const rule = enable ? this.matchRule(ctx.path, rules) : null;
    if (!rule) {
      cache.bump('bypass');
      if (streaming) return this.doRenderStream(ctx, 'BYPASS', header);
      const response = await this.doRender(ctx);
      return this.withState(response, 'BYPASS', header);
    }

    const key = this.buildKey(ctx, rule);
    const { state, entry } = cache.get(key);

    if (state === 'HIT') {
      cache.bump('hit');
      return this.withState(this.fromEntry(entry), 'HIT', header);
    }

    if (state === 'STALE') {
      cache.bump('stale');
      // 后台刷新：用独立的请求上下文副本，避免复用即将结束的 ctx
      const reqInfo = { ...entry.reqInfo };
      cache
        .singleflight(`${key}#refresh`, async () => {
          cache.bump('refresh');
          const response = await this.doRenderRaw(reqInfo);
          if (this.isCacheable(response)) cache.set(key, response, rule, reqInfo);
          return response;
        })
        .catch(err => ctx.logger.warn('[html-cache] 后台刷新失败: %s', err.message));
      return this.withState(this.fromEntry(entry), 'STALE', header);
    }

    // MISS
    cache.bump('miss');
    if (streaming) {
      // 流式下 Readable 只能被消费一次，无法像字符串那样在并发请求间共享，
      // 因此不走 singleflight；渲染完成后把完整 HTML 写入缓存，后续请求即命中。
      const reqInfo = this.getReqInfo(ctx);
      return this.doRenderStream(ctx, 'MISS', header, { rule, key, reqInfo });
    }
    const response = await cache.singleflight(key, () => this.doRender(ctx));
    const reqInfo = this.getReqInfo(ctx);
    if (this.isCacheable(response)) cache.set(key, response, rule, reqInfo);
    return this.withState(response, 'MISS', header);
  }

  /**
   * 流式渲染：返回 { stream, statusCode, headers }，由 controller pipe 到原生 res。
   * 渲染器的 done Promise 在流结束时 resolve 出完整 HTML，此时写入缓存。
   * 状态码非 200（如 404）不写缓存，但仍以流的方式发送。
   */
  doRenderStream(ctx, state, header, cacheTarget = null) {
    const { app } = this;
    ctx.req.query = ctx.query;
    const result = app.ssrRenderer.renderToStream(
      { req: ctx.req, url: `${ctx.path}${ctx.search || ''}`, query: ctx.query },
      {
        renderMode: app.config.ssr.renderMode,
        devScript: app.devReload ? app.devReload.devScript : undefined,
      }
    );

    // state 头必须在写流之前设置，controller 已提前把 headers 交给 ctx.set
    const headers = { ...(result.headers || {}), [header]: state };

    if (cacheTarget && result.statusCode === 200) {
      result.done
        .then(html => {
          const response = { statusCode: result.statusCode, headers: {}, value: html };
          app.htmlCache.set(cacheTarget.key, response, cacheTarget.rule, cacheTarget.reqInfo);
        })
        .catch(err => ctx.logger.warn('[html-cache] 流式渲染结果写入缓存失败: %s', err.message));
    }

    return {
      statusCode: result.statusCode,
      statusText: result.statusText,
      headers,
      stream: result.stream,
      abort: result.abort,
      cacheState: state,
    };
  }

  /** 按配置的 rules 顺序匹配 pathname，返回第一条命中的规则 */
  matchRule(pathname, rules = []) {
    for (const rule of rules) {
      if (typeof rule.match === 'string' && rule.match === pathname) return rule;
      if (rule.match instanceof RegExp && rule.match.test(pathname)) return rule;
    }
    return null;
  }

  /** 缓存 key 包含 pathname + query，可选按 header 扩展（如 vary: ['cookie']） */
  buildKey(ctx, rule) {
    let key = `${ctx.path}${ctx.search || ''}`;
    if (Array.isArray(rule.vary)) {
      for (const name of rule.vary) {
        key += `|${name}=${ctx.get(name) || ''}`;
      }
    }
    return key;
  }

  getReqInfo(ctx) {
    return {
      url: `${ctx.path}${ctx.search || ''}`,
      method: ctx.method,
      query: { ...ctx.query },
      headers: { ...ctx.headers },
    };
  }

  /** 正常渲染：把 egg ctx.req/ctx.res 交给 SSR 渲染器的 renderToHTML */
  async doRender(ctx) {
    const { app } = this;
    ctx.req.query = ctx.query;
    const response = await app.ssrRenderer.renderToHTML(
      { req: ctx.req, res: ctx.res },
      { renderMode: app.config.ssr.renderMode }
    );
    return response || {};
  }

  /**
   * 后台刷新用的「裸渲染」：伪造最小 req/res，避免复用已结束的 ctx。
   * 渲染器只用 req.url / req.query，res 在 renderToHTML 路径下不写。
   */
  async doRenderRaw(reqInfo) {
    const { app } = this;
    const req = {
      url: reqInfo.url,
      method: reqInfo.method || 'GET',
      headers: reqInfo.headers || {},
      query: reqInfo.query || {},
    };
    const res = { setHeader() {}, getHeader() {}, end() {}, statusCode: 200 };
    const response = await app.ssrRenderer.renderToHTML(
      { req, res },
      { renderMode: app.config.ssr.renderMode }
    );
    return response || {};
  }

  isCacheable(response) {
    return response.statusCode === 200 && typeof response.value === 'string';
  }

  fromEntry(entry) {
    return {
      statusCode: entry.statusCode,
      headers: { ...entry.headers },
      value: entry.value,
    };
  }

  withState(response, state, header) {
    return {
      ...response,
      cacheState: state,
      headers: { ...(response.headers || {}), [header]: state },
    };
  }
};
