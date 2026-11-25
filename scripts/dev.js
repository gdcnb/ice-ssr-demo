'use strict';

/**
 * 开发环境一键启动：webpack --watch + egg-bin dev。
 *
 * 之前需要手动开两个终端分别跑 `npm run build:watch` 和 `npm run server`，
 * 而且改了 SSR bundle 后 egg 不会重新加载渲染器（require cache 还在）。
 * 这里把构建和服务串起来，配合 server/lib/dev-hot-reload.js 实现：
 *   - 源码变化 -> webpack 自动重编 client / server
 *   - SSR bundle 变化 -> egg 原地替换 renderer，不重启进程
 *   - 浏览器收到 SSE 事件 -> JS 变更整页刷新，CSS 变更原地换样式
 *
 * 用法：npm run dev
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const bin = name => path.join(root, 'node_modules', '.bin', name);

// 显式指定 development，让 webpack 的 mode 与 NODE_ENV 保持一致。
// SSR_HMR=true 只在 dev 一键启动时设置，用于打开 webpack HMR + React Fast Refresh；
// 普通 build / build:watch 不带这个变量，行为与之前完全一致。
const childEnv = { ...process.env, NODE_ENV: 'development', SSR_HMR: 'true' };

const children = [];
let stopping = false;

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env: childEnv,
    stdio: 'inherit',
  });
  children.push({ name, child });

  child.on('error', err => {
    console.error(`[dev] ${name} 启动失败: ${err.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[dev] ${name} 退出 (code=${code}, signal=${signal || '-'})，关闭其他进程`);
    shutdown(code || 1);
  });

  return child;
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (!child.killed) {
      try {
        child.kill('SIGTERM');
      } catch (_) {
        // 进程已结束，忽略
      }
    }
  }
  // 给子进程一点时间清理（egg 会关 worker / 释放端口）
  setTimeout(() => process.exit(code), 500).unref();
}

/** 首次构建：清空 dist、复制 favicon，然后跑一次完整 webpack 编译 */
function initialBuild() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const favicon = path.join(root, 'public', 'favicon.ico');
  if (fs.existsSync(favicon)) {
    fs.copyFileSync(favicon, path.join(distDir, 'favicon.ico'));
  }

  console.log('[dev] 首次构建 webpack ...');
  execFileSync(bin('webpack'), [ '--config', path.join(root, 'webpack.config.js') ], {
    cwd: root,
    env: childEnv,
    stdio: 'inherit',
  });
}

async function main() {
  initialBuild();

  console.log('[dev] 启动 webpack --watch');
  start('webpack', bin('webpack'), [
    '--config',
    path.join(root, 'webpack.config.js'),
    '--watch',
  ]);

  console.log('[dev] 启动 egg-bin dev');
  start('egg', bin('egg-bin'), [ 'dev', '--baseDir=./server' ]);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch(err => {
  console.error('[dev] 启动失败:', err);
  shutdown(1);
});
