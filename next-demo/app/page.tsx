import HomeClient from './HomeClient';

// 对应原 egg HTML 缓存规则：{ match: '/', ttl: 60s, staleWhileRevalidate: 5min }
// Next.js 的 ISR 本身就是 stale-while-revalidate 语义：过期后先返回旧内容，
// 后台重新生成，因此这里只需声明 revalidate 秒数。
// 注意：route segment config 必须写在 Server Component 里，故页面拆成
// 本文件（服务端，负责缓存策略）+ HomeClient（客户端，负责交互）。
export const revalidate = 60;

export default function IndexPage() {
  return <HomeClient />;
}
