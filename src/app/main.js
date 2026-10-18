'use strict';
/**
 * 主进程：只做装配（数据目录 / 注册表 / 服务 / 窗口），业务逻辑在 src/app 与 src/platforms。
 */

const path = require('path');
const { app, BrowserWindow, shell, Tray, Menu, nativeImage } = require('electron');
const { Store, DATA_DIR_NAME, LEGACY_DATA_DIR_NAME } = require('../core/store');
const { Logger } = require('../core/log');
const { BrowserSession } = require('../core/browser');
const { Registry } = require('../platforms/registry');
const { Notifier, LoginService, Scheduler, WebViewer } = require('./services');
const { Api } = require('./api');
const autostart = require('./autostart');

const windows = new Set();
let tray = null;
let store;
let registry;
let scheduler;
let notifier;
let login;
let browser;
let viewer;
let logger;
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
    // 只把 http(s) 交给系统；bytedance:// 等自定义协议交给系统会弹「找应用」，直接忽略
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => { /* 打不开就算了 */ });
    return { action: 'deny' };
  });
  // 页面自己跳 bytedance:// 这类自定义协议时（不开新窗口），同样别让它弹系统框
  contents.on('will-navigate', (event, url) => {
    if (!/^(https?|file|about|blob|data|devtools|chrome-extension):/i.test(url)) event.preventDefault();
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
  if (logger) logger.error(`${reason} - ${url}`);
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
  win.on('close', (event) => {
    // 常驻托盘：点关闭只是藏到托盘，调度器继续后台跑；真正退出走托盘「退出」或 before-quit。
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => windows.delete(win));
  windows.add(win);
  return win;
}

/** 从托盘恢复主窗口；窗口被销毁了则重建。 */
function showMainWindow() {
  const win = [...windows][0];
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    createMainWindow();
  }
}

/** 创建系统托盘：左键恢复窗口，右键菜单可退出。 */
function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('你快更新啊 - 追更提醒');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', () => showMainWindow());
}

/**
 * 事件的日志摘要：只留排错用得上的几个字段，
 * 免得 sync:done 里的整包数据把日志撑成几千行。
 */
function brief(name, data) {
  if (!data) return '';
  const f = {
    'sync:start': (d) => ` 待刷新 ${d.count ?? d.total ?? ''} 个`,
    'sync:done': (d) => ` 新增 ${d.added || 0} 条${d.failures?.length ? `，失败 ${d.failures.length} 个` : ''}`,
    'collect:done': (d) => ` 新增 ${d.added || 0} 条`,
    'collect:failed': (d) => ` ${d.message || ''}`,
    'login:changed': (d) => ` ${d.platformId} ok=${d.ok}`,
    'source:added': (d) => ` ${d.name || d.id}`,
    'source:removed': (d) => ` ${d.sourceId}`,
    'source:updated': (d) => ` ${d.sourceId}`,
    'settings:changed': () => ' 设置已更新',
  }[name];
  return f ? f(data) : '';
}

/** 装配全部依赖。 */
function bootstrap() {
  const root = resolveDataRoot();
  store = new Store(root);
  // 日志每次启动重写一份，先建好，后面每一步都能往里记
  logger = new Logger(store.globalDir);
  logger.verbose = !app.isPackaged; // 开发态顺带打到控制台
  logger.start([
    `版本 ${require('../../package.json').version}`,
    `运行环境 Electron ${process.versions.electron} / Node ${process.versions.node} / Chrome ${process.versions.chrome}`,
    `系统 ${process.platform} ${process.arch}`,
    `运行方式 ${app.isPackaged ? '打包版' : '开发模式'}`,
    `程序 ${process.env.PORTABLE_EXECUTABLE_FILE || process.execPath}`,
    `数据目录 ${root}`,
  ]);
  logger.info('数据目录就绪');
  // 诊断日志属于全局数据，跟着 _global 走
  viewer = new WebViewer(store.globalDir);
  notifier = new Notifier(store, () => scheduler.settings(), viewer);
  browser = new BrowserSession();
  const emit = (name, data) => {
    logger.info(`事件 ${name}${brief(name, data)}`);
    for (const win of windows) if (!win.isDestroyed()) win.webContents.send('event', { name, data });
  };
  const log = (msg, level) => logger.line((level || 'info').toUpperCase(), msg);
  registry = new Registry(store, { browser, notify: notifier, emit, log });
  logger.info(`平台注册表就绪：${registry.list().map((p) => p.id).join(', ')}`);
  scheduler = new Scheduler({ registry, store, notifier, emit, log, browser });
  // 登录成功或窗口关闭都要通知界面刷新登录状态（否则界面一直显示「未登录」）
  login = new LoginService(registry, (info) => emit('login:changed', info));
  const api = new Api({
    store, registry, scheduler, notifier, login, browser, viewer, logger,
    windows: () => windows, emit,
  });
  api.register();
  logger.info('装配完成');
}

/**
 * 登录态回灌：session.json → 浏览器分区。
 * 打包后 userData 换了目录，persist 分区是空的，落盘的登录态不回灌就全是未登录，
 * 抖音会静默拿不到作品列表（只给资料）。分区里已经有凭证的就不动它。
 */
async function restoreLoginCookies() {
  for (const def of registry.list()) {
    const raw = def.login?.cookieUrl || def.login?.entry || def.urls?.list || def.homeUrl || '';
    let url = '';
    try { url = new URL(raw).origin; } catch { continue; }
    const needed = def.login?.cookieNames || []; // 只认「登录后才有的凭证 cookie」，不记值
    try {
      const saved = store.readSession(def.id) || {};
      const jar = saved.cookies || {};
      const names = Object.keys(jar);
      const savedCred = needed.filter((n) => jar[n]);
      const before = await BrowserSession.readCookies(url);
      const beforeCred = needed.filter((n) => before[n]);
      logger.info(`${def.name} 登录态存档：${names.length ? `cookie ${names.length} 个，凭证 ${savedCred.length}/${needed.length}${savedCred.length ? `（${savedCred.join('、')}）` : ''}` : '没有存档'}`);
      logger.info(`${def.name} 浏览器分区：cookie ${Object.keys(before).length} 个，凭证 ${beforeCred.length}/${needed.length}${beforeCred.length ? `（${beforeCred.join('、')}）` : ''}`);
      if (beforeCred.length) { logger.info(`${def.name} 分区里已有登录凭证，不回灌`); continue; }
      if (!names.length) {
        logger.warn(`${def.name} 未登录：存档和分区都没有凭证，请在设置里点「登录」后重启`);
        continue;
      }
      const n = await BrowserSession.restoreCookies(url, jar);
      const after = await BrowserSession.readCookies(url);
      const afterCred = needed.filter((x) => after[x]);
      const msg = `${def.name} 回灌 ${n} 个 cookie → 分区凭证 ${afterCred.length}/${needed.length}`;
      if (afterCred.length) logger.info(`${msg}（已登录）`);
      else logger.warn(`${msg}（仍然没有凭证，多半是存档里的登录态已过期，需要重新登录）`);
    } catch (err) {
      logger.warn(`${def.name} 登录态回灌失败：${err?.message || err}`);
    }
  }
}

app.whenReady().then(async () => {
  bootstrap();
  await restoreLoginCookies();
  createMainWindow();
  createTray();
  logger.info('主窗口已创建，已常驻系统托盘');
  scheduler.start();
  logger.info('调度已启动');
  // 便携版整目录搬走后，注册表里的启动项还指向旧 exe，等于自启悄悄失效。
  // 每次启动对一下：设置里记着「开了」，但系统里没有，就按现在的 exe 重新登记。
  try {
    const saved = store.readGlobal('settings.json', {});
    const state = autostart.supported() ? autostart.get() : { supported: false, enabled: false };
    logger.info(`开机自启：设置=${!!saved.openAtLogin} 系统=${!!state.enabled}`);
    if (saved.openAtLogin && state.supported && !state.enabled) {
      autostart.set(true);
      logger.info('开机自启已按当前程序路径重新登记');
    }
  } catch (err) { /* 被安全软件拦掉就算了，不改用户设置 */
    logger.warn('开机自启对账失败：' + (err?.message || err));
  }
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
    if (logger) logger.info('准备退出');
    scheduler.stop();
    login.close();
    viewer.close();
    browser.close().catch(() => { /* 已经关了 */ });
  } finally {
    setImmediate(() => app.exit(0));
  }
});

// 常驻托盘：窗口被关（实际是 hide）也不退出，真正退出由托盘「退出」触发 before-quit。
app.on('window-all-closed', () => { /* 不退出 */ });

/** 兜底：没被 catch 的异常以前只在控制台一闪而过，现在必须留在日志里。 */
process.on('uncaughtException', (err) => {
  const text = (err && err.stack) || String(err);
  if (logger) logger.error('未捕获异常：' + text); else console.error(text);
});
process.on('unhandledRejection', (reason) => {
  const text = (reason && reason.stack) || String(reason);
  if (logger) logger.error('未处理的异步失败：' + text); else console.error(text);
});
