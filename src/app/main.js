'use strict';
/**
 * 主进程：只做装配（数据目录 / 注册表 / 服务 / 窗口），业务逻辑在 src/app 与 src/platforms。
 */

const path = require('path');
const { app, BrowserWindow, shell } = require('electron');
const { Store, DATA_DIR_NAME, LEGACY_DATA_DIR_NAME } = require('../core/store');
const { BrowserSession } = require('../core/browser');
const { Registry } = require('../platforms/registry');
const { Notifier, LoginService, Scheduler, WebViewer } = require('./services');
const { Api } = require('./api');

const windows = new Set();
let store;
let registry;
let scheduler;
let notifier;
let login;
let browser;
let viewer;
let quitting = false;

/**
 * 便携数据目录 = exe 同级的 up-watcher-data/（旧名 UPWatcher-data 自动迁移）。
 * 单文件便携版用 electron-builder 注入的 PORTABLE_EXECUTABLE_DIR（真实 exe 所在目录，
 * 而不是临时解包目录）；解包版在 win-unpacked 下，需要从 resources/app.asar 上跳两级。
 *
 * --data-root=<目录> 只允许开发态使用（自测隔离），打包后一律忽略，
 * 免得把测试数据写进用户真实的数据目录。
 */
function resolveDataRoot() {
  const fs = require('fs');
  const override = app.isPackaged ? null : process.argv.find((a) => a.startsWith('--data-root='));
  const candidates = override
    ? [override.slice('--data-root='.length)]
    : (app.isPackaged
      ? [
        process.env.PORTABLE_EXECUTABLE_DIR,
        path.resolve(process.resourcesPath, '..'),
        path.dirname(process.execPath),
      ]
      : [path.resolve(__dirname, '..', '..')]); // 开发态：项目根
  for (const base of candidates) {
    if (!base) continue;
    const dir = path.join(base, DATA_DIR_NAME);
    const legacy = path.join(base, LEGACY_DATA_DIR_NAME);
    try {
      // 旧版本数据目录自动改名，老用户的历史与配置不丢
      if (!fs.existsSync(dir) && fs.existsSync(legacy)) fs.renameSync(legacy, dir);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch { /* 只读目录，试下一个 */ }
  }
  return path.join(process.cwd(), DATA_DIR_NAME);
}

/** 单实例：便携工具同时开两份会互相抢数据目录。 */
if (!app.requestSingleInstanceLock()) {
  // 开发态给出明确提示：旧实例没关时 npm start 会「秒退」，
  // 用户看到的还是旧窗口，极易误以为新代码没生效。
  if (!app.isPackaged) {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      '已有一个「你快更新啊」在运行',
      '新实例无法启动：有一个旧窗口（或打包版）还开着，占着单实例锁。\n\n'
        + '请关闭那个窗口，或到任务管理器结束 electron / up-watcher 进程，\n然后重新运行 npm start。',
    );
  }
  app.quit();
}

app.on('second-instance', () => {
  const main = [...windows][0];
  if (main) { if (main.isMinimized()) main.restore(); main.focus(); }
});

/** 只允许载入本地界面；界面里打开的外链一律进内置浏览器（带登录态），非网页地址才交给系统。 */
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (viewer && viewer.open(url)) return { action: 'deny' };
    shell.openExternal(url).catch(() => { /* 打不开就算了 */ });
    return { action: 'deny' };
  });
});

/**
 * 进程异常要能看见：以前渲染进程崩了应用会静默消失，
 * 用户只看到「闪退」，完全查不出原因。
 */
app.on('render-process-gone', (_event, contents, details) => {
  reportCrash('页面进程异常退出', contents, details);
});
app.on('child-process-gone', (_event, details) => {
  console.error('[crash] 子进程异常退出:', JSON.stringify(details));
});

function reportCrash(label, contents, details) {
  let url = '未知页面';
  try { url = contents.getURL(); } catch { /* 已销毁 */ }
  const reason = `${label}（${details.reason}${details.exitCode !== undefined ? `, code=${details.exitCode}` : ''}）`;
  console.error(`[crash] ${reason} - ${url}`);
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send('event', { name: 'app:crash', data: { message: reason, url } });
  }
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1120,
    minHeight: 700,
    title: '你快更新啊',
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => windows.delete(win));
  windows.add(win);
  return win;
}

/** 装配全部依赖。 */
function bootstrap() {
  store = new Store(resolveDataRoot());
  // 诊断日志属于全局数据，跟着 _global 走
  viewer = new WebViewer(path.join(store.root, '_global'));
  notifier = new Notifier(store, () => scheduler.settings(), viewer);
  browser = new BrowserSession();
  const emit = (name, data) => {
    for (const win of windows) if (!win.isDestroyed()) win.webContents.send('event', { name, data });
  };
  registry = new Registry(store, { browser, notify: notifier, emit });
  scheduler = new Scheduler({ registry, store, notifier, emit });
  // 登录成功或窗口关闭都要通知界面刷新登录状态（否则界面一直显示「未登录」）
  login = new LoginService(registry, (info) => emit('login:changed', info));
  const api = new Api({
    store, registry, scheduler, notifier, login, browser, viewer, windows: () => windows, emit,
  });
  api.register();
}

app.whenReady().then(() => {
  bootstrap();
  createMainWindow();
  scheduler.start();
  app.on('activate', () => { if (!windows.size) createMainWindow(); });
});

/**
 * 退出时收干净：停调度、关隐藏窗口/登录窗口，避免半截写入。
 * 同步做完能同步做的事（preventDefault 必须同步调用才有效），
 * 然后直接退出——隐藏窗口只是抓取用的，不会丢数据。
 */
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  try {
    scheduler.stop();
    login.close();
    viewer.close();
    browser.close().catch(() => { /* 已经关了 */ });
  } finally {
    setImmediate(() => app.exit(0));
  }
});

app.on('window-all-closed', () => app.quit());
