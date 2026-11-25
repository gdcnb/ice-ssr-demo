import styles from './index.module.css';
import AppNav from '../components/AppNaviagtor';

// 对应原 egg HTML 缓存规则：{ match: /^\/home$/, ttl: 30s }
export const revalidate = 30;

export default function Home() {
  return (
    <>
      <h1 className={styles.homeTitle}>Home page</h1>
      <AppNav />
      <section>home content</section>
    </>
  );
}
