import {useState} from 'react';
import AppNav from '@/components/AppNaviagtor';

import styles from './index.module.scss';

export default function Home() {
  return (
    <>
      <h1 className={styles.homeTitle}>Home page</h1>
      <AppNav></AppNav>
      <section>
        home content
      </section>
    </>
  )
}