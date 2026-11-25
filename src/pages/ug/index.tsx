import {Suspense, useState} from 'react';

import styles from './index.module.scss';
import AppNav from '@/components/AppNaviagtor';
import {suspendForDelay} from '@/ug-delay';

/**
 * 演示流式 SSR：服务端渲染「UG content」前挂起 3s，
 * fallback 随 shell 立即发出，3s 后 React 通过流式分块推送真实内容。
 * 浏览器 hydrate 与非流式渲染不延迟。
 */
function DelayedContent() {
  suspendForDelay();
  return <section>UG content</section>;
}

export default function Ug() {
  const [pageName, setPageName] = useState('UG page');
  const [count, setCount] = useState(1);
  return (
    <>
      <h1
        className={styles.pageTitle}
        onClick={() => {
          setCount((c) => c + 1);
        }}
      >{pageName} {count} 3 </h1>
      <AppNav></AppNav>
      <Suspense fallback={<section>loading...（3 秒后显示内容）</section>}>
        <DelayedContent />
      </Suspense>
    </>
  )
}
