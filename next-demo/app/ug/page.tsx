import styles from './index.module.css';
import AppNav from '../components/AppNaviagtor';

// 对应原项目：/ug 没有缓存规则，egg 侧每次 BYPASS 实时渲染。
// App Router 里用 force-dynamic 强制每次请求动态渲染，不走 ISR 缓存。
export const dynamic = 'force-dynamic';

export default function Ug() {
  return (
    <>
      <h1 className={styles.pageTitle}>UG page</h1>
      <AppNav />
      <section>UG content</section>
    </>
  );
}
