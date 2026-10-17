// 界面构建已改由 scripts/build-ui.cjs 编排（逐页构建 + 关闭代码分块），
// 保留本配置仅供编辑器 / vite 单页预览使用，实际打包以 build:ui 脚本为准。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/ui-src',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../ui',
    emptyOutDir: true,
    target: 'chrome120',
  },
});
