'use strict';
/**
 * 开发态启动前清理旧实例：占着单实例锁的 electron 进程会让新实例静默退出，
 * 用户看到的还是旧窗口，极易误以为新代码没生效。
 * 只杀「本项目 node_modules 里那个 electron.exe」的进程，不动其它程序
 * （VS Code 是 Code.exe、Chrome 是 chrome.exe，本来也不叫 electron.exe）。
 */
const { execFileSync } = require('child_process');
const path = require('path');

function main() {
  // 纯 Node 环境下 require('electron') 导出的是 electron 可执行文件的路径
  let electronExe;
  try { electronExe = require('electron'); } catch { return; }
  if (typeof electronExe !== 'string' || !electronExe.endsWith('.exe')) return;
  electronExe = path.resolve(electronExe).replace(/'/g, "''");

  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'"`,
    `  | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.Replace('/', '\\') -ieq '${electronExe}') }`,
    `  | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    'Start-Sleep -Milliseconds 600', // 等单实例锁释放
  ].join(' ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
  } catch { /* 没有旧实例 / 权限不足都不影响启动 */ }
}

main();
