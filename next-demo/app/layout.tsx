import type { Metadata } from 'next';
import './global.css';

export const metadata: Metadata = {
  title: 'webpack SSR Demo',
  description: 'webpack + egg SSR demo',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body>{children}</body>
    </html>
  );
}
