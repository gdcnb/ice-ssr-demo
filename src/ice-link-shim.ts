/**
 * webpack 方案对 ice 虚拟模块 `ice` 的兼容层。
 *
 * 页面组件统一写 `import { Link } from 'ice'`：
 * - ice 构建时，`ice` 是其运行时提供的虚拟模块，Link 由 @ice/runtime 从
 *   react-router-dom re-export，且与 ice 自己的 Router context 是同一实例。
 * - webpack 构建时没有这个虚拟模块，通过 resolve.alias 把精确的 `ice` 请求
 *   指向本文件，从 react-router-dom re-export 等价的 Link；此时页面被
 *   entry-client / entry-server 里的 BrowserRouter / StaticRouter 包裹，context 正常。
 *
 * 这样同一份 AppNaviagtor 源码在两套方案里都能拿到各自正确的 Link，
 * 不需要在组件里写构建工具判断，也不会把两套 Router 混用。
 */
export { Link } from 'react-router-dom';
