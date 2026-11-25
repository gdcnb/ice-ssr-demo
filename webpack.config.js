'use strict';

/**
 * 纯 webpack 的 SSR 双端构建配置（替代 ice build）。
 *
 * - client 编译：src/entry-client.tsx -> dist/js/main.js + dist/css/main.css（全局样式）
 *   页面 CSS 跟随各自的异步 chunk 输出为 dist/css/page-*.css，按需加载
 * - server 编译：src/entry-server.tsx -> dist/server/index.js (CommonJS)
 *
 * 产物输出到 dist/，build/ 保留给 icejs 使用，方便对比两套方案的构建产物。
 * 导出契约与原 ice 产物一致（renderToHTML），egg 侧无需感知构建工具的变化。
 */

const path = require('path');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const ReactRefreshPlugin = require('@pmmmwh/react-refresh-webpack-plugin');

const root = __dirname;
const srcDir = path.join(root, 'src');
// webpack 产物输出到 dist/，build/ 专供 icejs 构建，两套产物可同时保留用于对比
const distDir = path.join(root, 'dist');
const isProd = process.env.NODE_ENV === 'production';
const mode = isProd ? 'production' : 'development';

// Fast Refresh 只在 `npm run dev`（由 scripts/dev.js 设置 SSR_HMR=true）时启用。
// 普通 build / build:watch 不受影响，产物里不会混入 Refresh runtime。
const enableHmr = !isProd && process.env.SSR_HMR === 'true';

// 两端必须使用完全相同的 localIdentName，否则 SSR 与客户端 hydrate 的 className 不一致
const LOCAL_IDENT = '[name]__[local]__[hash:base64:5]';

const resolve = {
  extensions: [ '.js', '.jsx', '.ts', '.tsx', '.json' ],
  alias: {
    '@': srcDir,
    // 页面组件统一写 import { Link } from 'ice'：ice 构建用其运行时虚拟模块，
    // webpack 构建没有该模块，把精确的 ice 请求映射到 react-router-dom 兼容层。
    // '$' 后缀表示精确匹配，只影响 `import ... from 'ice'`，不碰 ice/xxx 之类路径。
    'ice$': path.join(srcDir, 'ice-link-shim.ts'),
  },
};

function babelRule(isServer) {
  return {
    test: /\.[jt]sx?$/,
    include: srcDir,
    use: {
      loader: 'babel-loader',
      options: {
        babelrc: false,
        configFile: false,
        presets: [
          [ '@babel/preset-env', {
            // 服务端直接用当前 Node 语法，无需降级；客户端读 .browserslistrc
            targets: isServer ? { node: 'current' } : undefined,
            modules: false,
          } ],
          [ '@babel/preset-react', { runtime: 'automatic' } ],
          '@babel/preset-typescript',
        ],
        // Fast Refresh 的 Babel 变换只在 client 且 dev 开启；server bundle 不能带
        // refresh runtime（它依赖 window，SSR 在 Node 里执行）。
        plugins: enableHmr && !isServer ? [ require.resolve('react-refresh/babel') ] : [],
      },
    },
  };
}

function cssLoaderOptions(isServer, isModule, importLoaders) {
  if (isServer) {
    // 服务端不产出 CSS 文件，只导出 CSS Modules 的 className 映射
    return {
      modules: { exportOnlyLocals: true, localIdentName: LOCAL_IDENT },
      importLoaders,
    };
  }
  if (isModule) {
    return { modules: { localIdentName: LOCAL_IDENT }, importLoaders };
  }
  return { importLoaders };
}

function styleRules(isServer) {
  // 客户端用 MiniCssExtractPlugin 抽出 .css；服务端不需要
  const wrap = loaders =>
    isServer ? loaders : [ MiniCssExtractPlugin.loader, ...loaders ];
  const sass = isServer ? 'sass-loader' : { loader: 'sass-loader', options: { sassOptions: { quietDeps: true } } };

  return [
    {
      test: /\.(css|scss)$/,
      oneOf: [
        {
          test: /\.module\.css$/,
          use: wrap([ { loader: 'css-loader', options: cssLoaderOptions(isServer, true, 0) } ]),
        },
        {
          test: /\.module\.scss$/,
          use: wrap([
            { loader: 'css-loader', options: cssLoaderOptions(isServer, true, 1) },
            sass,
          ]),
        },
        {
          test: /\.css$/,
          use: wrap([ { loader: 'css-loader', options: cssLoaderOptions(isServer, false, 0) } ]),
        },
        {
          test: /\.scss$/,
          use: wrap([
            { loader: 'css-loader', options: cssLoaderOptions(isServer, false, 1) },
            sass,
          ]),
        },
      ],
    },
  ];
}

function assetRule(isServer) {
  return {
    test: /\.(png|jpe?g|gif|webp|svg)$/,
    type: 'asset/resource',
    generator: {
      // 输出到 dist/js/，与 egg-static 的 /js/ 前缀一致
      filename: 'js/[name][ext]',
      // 服务端只需拿到 URL 字符串，不重复 emit 文件
      ...(isServer ? { emit: false, publicPath: '/' } : {}),
    },
  };
}

const clientConfig = {
  name: 'client',
  mode,
  target: 'web',
  entry: { main: path.join(srcDir, 'entry-client.tsx') },
  output: {
    path: distDir,
    filename: 'js/[name].js',
    // 异步页面 chunk 用 webpackChunkName 命名（page-home / page-ug / page-index），
    // 文件名稳定可预测，服务端才能 preload 到同一个 URL
    chunkFilename: 'js/[name].js',
    publicPath: '/',
    // HMR 增量包默认落在 dist 根目录且不在 /js 前缀下，egg-static 只映射了
    // /js 和 /css，所以把 manifest 与 hot chunk 都指到 js/ 目录。
    ...(enableHmr
      ? {
          hotUpdateMainFilename: 'js/[runtime].[fullhash].hot-update.json',
          hotUpdateChunkFilename: 'js/[id].[fullhash].hot-update.js',
        }
      : {}),
  },
  resolve,
  module: {
    rules: [ babelRule(false), ...styleRules(false), assetRule(false) ],
  },
  plugins: [
    ...(enableHmr
      ? [
          new webpack.HotModuleReplacementPlugin(),
          // hot: true 让插件接管 module.hot.check 的应用阶段；我们不用它自带的
          // WebSocket 客户端（overlay/socket 都关掉），触发来自 egg 的 SSE。
          new ReactRefreshPlugin({
            overlay: false,
            exclude: /node_modules/,
          }),
        ]
      : []),
    new MiniCssExtractPlugin({
      // 同步入口（global.css）-> main.css；异步页面 chunk -> page-xxx.css
      // 两个名字与 page-assets.ts 的映射保持一致，服务端才能精确注入
      filename: 'css/[name].css',
      chunkFilename: 'css/[name].css',
    }),
  ],
  devtool: isProd ? false : 'cheap-module-source-map',
  performance: { hints: false },
};

const serverConfig = {
  name: 'server',
  mode,
  target: 'node',
  // 只把 Node 内置模块留作 require，第三方依赖打进 bundle，运行不依赖 node_modules 链接
  externalsPresets: { node: true },
  entry: { index: path.join(srcDir, 'entry-server.tsx') },
  output: {
    path: path.join(distDir, 'server'),
    filename: '[name].js',
    library: { type: 'commonjs2' },
  },
  resolve,
  module: {
    rules: [ babelRule(true), ...styleRules(true), assetRule(true) ],
  },
  devtool: false,
  performance: { hints: false },
};

module.exports = [ clientConfig, serverConfig ];
