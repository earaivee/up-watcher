/**
 * antd message 的模块级句柄：非组件代码（事件处理等）也能发 toast。
 * 类型沿用旧界面的约定：''=普通 'ok'=成功 'err'=失败。
 */
let api = null;

export const bindMessage = (m) => { api = m; };

export const toast = (content, type = '') => {
  if (!api) return;
  const fn = type === 'ok' ? 'success' : type === 'err' ? 'error' : 'info';
  api[fn](String(content ?? ''));
};
