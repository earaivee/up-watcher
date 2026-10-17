'use strict';
/**
 * 开机自启：Windows 写注册表 Run 项，macOS 写登录项（Linux 没有统一机制，直接不支持）。
 *
 * 便携版 exe 会被用户整目录搬走，登录项里必须登记「真实 exe」
 * （electron-builder 注入的 PORTABLE_EXECUTABLE_FILE），
 * 不能登记解包临时目录里的副本，否则下次开机指向的是一个已经不存在的路径。
 */

const { app } = require('electron');

/** 开机自启要跑的程序：优先便携版真实 exe，否则当前可执行文件。 */
function launchPath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

/** 开发态跑的是 electron.exe，必须带上应用目录，否则开机起来的是个空壳。 */
function launchArgs() {
  if (app.isPackaged) return [];
  return process.argv[1] ? [process.argv[1]] : [];
}

/** Electron 的登录项目前只支持 Windows / macOS。 */
function supported() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

function get() {
  if (!supported()) return { supported: false, enabled: false, reason: '当前系统不支持开机自启' };
  const info = app.getLoginItemSettings({ path: launchPath(), args: launchArgs() });
  return { supported: true, enabled: !!info.openAtLogin, path: launchPath() };
}

function set(enabled) {
  if (!supported()) throw new Error('当前系统不支持开机自启');
  const path = launchPath();
  const args = launchArgs();
  app.setLoginItemSettings({ openAtLogin: !!enabled, path, args });
  // 写完立刻回读：安全软件/组策略会悄悄拦掉启动项，不能只信「调用没报错」
  const info = app.getLoginItemSettings({ path, args });
  if (!!info.openAtLogin !== !!enabled) {
    throw new Error('系统没有接受这个启动项，可能被安全软件拦截');
  }
  return get();
}

module.exports = { get, set, supported };
