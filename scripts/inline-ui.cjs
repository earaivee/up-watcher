'use strict';
/**
 * 构建后处理：把 vite 产出的 JS/CSS 内联进 src/ui 下的每个 html，变成单文件。
 * 原因：Electron 用 file:// 加载外链 ES 模块会被浏览器 CORS 策略拦下，
 * 内联后不存在外部请求，直接可用（替代 vite-plugin-singlefile，少一个依赖）。
 * 处理 index.html（主界面）与 toast.html（浮窗通知）等多个页面。
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'ui');
const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
if (!pages.length) throw new Error('[inline-ui] src/ui 下没有 html 产物，检查 vite 构建');

let inlined = 0;
for (const name of pages) {
  const file = path.join(dir, name);
  let html = fs.readFileSync(file, 'utf8');

  // <script type="module" ... src="./assets/xxx.js"></script> → 内联
  html = html.replace(/<script type="module"[^>]*src="\.?\/?(assets\/[^"]+)"[^>]*><\/script>/g, (_m, src) => {
    const code = fs.readFileSync(path.join(dir, src), 'utf8');
    inlined += 1;
    return `<script type="module">\n${code}\n</script>`;
  });

  // <link rel="stylesheet" ... href="./assets/xxx.css"> → 内联
  html = html.replace(/<link rel="stylesheet"[^>]*href="\.?\/?(assets\/[^"]+)"[^>]*>/g, (_m, href) => {
    const css = fs.readFileSync(path.join(dir, href), 'utf8');
    inlined += 1;
    return `<style>\n${css}\n</style>`;
  });

  fs.writeFileSync(file, html, 'utf8');
  console.log(`[inline-ui] ${name} 已内联为单文件`);
}

if (!inlined) throw new Error('[inline-ui] 没找到可内联的资源，检查 vite 产物');
fs.rmSync(path.join(dir, 'assets'), { recursive: true, force: true });
console.log(`[inline-ui] 共内联 ${inlined} 份资源，页面：${pages.join(', ')}`);
