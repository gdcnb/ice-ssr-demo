'use client';

import { useState } from 'react';
import styles from './index.module.css';
import AppNav from './components/AppNaviagtor';

/** 首页交互部分（对应原 src/pages/index.tsx），useState 需要客户端组件 */
export default function HomeClient() {
  const [count, setCount] = useState(2);
  const updateCount = () => setCount(prev => prev + 1);

  return (
    <div className={styles.app}>
      <header>
        {/* 原项目 import logo -> webpack asset 模块；Next.js 放在 public/ 下直接引用 */}
        <img src="/logo.png" alt="logo" />
        <p>Hello ice.js 3 a</p>
      </header>
      <main>
        <AppNav />
        <button className={styles.button} type="button" onClick={updateCount}>
          👍🏻 {count}
        </button>
        <p>
          <a href="https://reactjs.org" target="_blank" rel="noopener noreferrer" className={styles.link}>
            Learn React
          </a>
          {' | '}
          <a href="https://v3.ice.work/" target="_blank" rel="noopener noreferrer" className={styles.link}>
            Learn ice.js
          </a>
        </p>
      </main>
    </div>
  );
}
