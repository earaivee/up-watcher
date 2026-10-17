'use strict';
/**
 * 界面构建编排：逐页构建（main / toast），每页单入口 + 关闭代码分块，
 * 保证每个 html 只依赖自己的一个 JS（inline-ui.cjs 才能内联成真正可用的单文件）。
 * 共享模块（React runtime）会在两页间重复一份——体积换正确性，值得。
 */
const path = require('path');

const PAGES = ['index', 'toast']; // 文件名即页面：index.html / toast.html
const rootDir = path.join(__dirname, '..', 'src', 'ui-src');

(async () => {
  const { build } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;

  for (const page of PAGES) {
    await build({
      configFile: false, // 不读 vite.config.mjs，这里自己给全量配置
      root: rootDir,
      base: './',
      plugins: [react()],
      logLevel: 'warn',
      build: {
        outDir: '../ui',
        emptyOutDir: page === PAGES[0], // 第一页清空产物目录，后续页面追加
        target: 'chrome120',
        rolldownOptions: {
          input: { [page]: path.join(rootDir, `${page}.html`) },
          output: { codeSplitting: false },
        },
      },
    });
    console.log(`[build-ui] ${page} 构建完成`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
