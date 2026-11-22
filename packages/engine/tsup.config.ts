import { defineConfig } from 'tsup';

export default defineConfig([
  // 浏览器端运行时：iife + 全局 __FMP__，生成的页面模板用普通 script 注册，不依赖 ESM 加载
  {
    entry: { runtime: 'src/runtime/index.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2020',
    globalName: '__FMP__',
    loader: { '.css': 'text' },
    minify: true,
    sourcemap: true,
    outExtension: () => ({ js: '.js' })
  },
  // Node 端：把小程序目录编译成静态站点
  {
    entry: { build: 'src/compiler/build.ts' },
    external: ['typescript'],
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    minify: true,
    sourcemap: true,
    outExtension: () => ({ js: '.js' })
  }
]);
