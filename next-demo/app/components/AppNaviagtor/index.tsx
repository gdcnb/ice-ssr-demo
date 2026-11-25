import Link from 'next/link';

// Next.js App Router 自带文件系统路由，不需要 react-router 的 BrowserRouter/StaticRouter。
// 这里的 Link 必须来自 next/link（属性是 href，不是 react-router 的 to），
// 否则 RouterContext 为 null，会在渲染/hydrate 时报
// "Cannot destructure property 'basename' of useContext(...) as it is null"。
export default function AppNav() {
  return (
    <ul>
      <li><Link href="/home">Home</Link></li>
      <li><Link href="/ug">UG</Link></li>
    </ul>
  );
}
