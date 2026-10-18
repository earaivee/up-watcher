'use strict';
/**
 * 桌面服务：右下角浮窗通知、Windows 原生通知、登录窗口、定时调度。
 * 一次性把「跟界面有关但不是界面本身」的东西集中在这里，主进程只做装配。
 */

const path = require('path');
const fsp = require('fs/promises');
const { BrowserWindow, Notification, screen, shell } = require('electron');
const { BrowserSession, PARTITION } = require('../core/browser');
const { parseRangeDays } = require('../core/net');

/* ------------------------------------------------------------ 内置浏览器 */

/**
 * 内置浏览器窗口：打开内容链接不再依赖系统浏览器（shell.openExternal 偶发失灵），
 * 且与登录窗口 / 抓取窗口共用同一个会话分区——点开 B站 / 抖音页面自带登录态。
 * 单窗口复用：再点别的链接就在同一个窗口里跳转。
 */
class WebViewer {
  /** logDir：数据目录，把每次打开的执行轨迹写进 open-link.log，方便诊断。 */
  constructor(logDir) {
    this.win = null;
    this.logDir = logDir || null;
  }

  note(msg) {
    if (!this.logDir) return;
    try {
      require('fs').appendFileSync(
        require('path').join(this.logDir, 'open-link.log'),
        `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}\n`, 'utf8');
    } catch { /* 日志写不进就算了 */ }
  }

  /** 打开（或复用窗口）加载链接；非 http(s) 地址返回 false，由调用方决定是否交给系统。 */
  open(url) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) { this.note(`忽略非网页地址: ${target}`); return false; }
    try {
      if (!this.win || this.win.isDestroyed()) {
        this.win = new BrowserWindow({
          width: 1280,
          height: 860,
          title: '你快更新啊 · 浏览器',
          autoHideMenuBar: true,
          webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
        });
        this.win.on('closed', () => { this.win = null; });
        this.note(`创建内置浏览器窗口: ${target}`);
      } else {
        this.note(`复用内置浏览器窗口: ${target}`);
      }
      // 先把窗口亮出来再加载：万一目标页加载慢或失败，用户也能看到窗口而不是「点了没反应」
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      this.win.loadURL(target).catch((e) => this.note(`页面加载失败(${target}): ${e && e.message}`));
      return true;
    } catch (e) {
      this.note(`内置浏览器打开异常(${target}): ${e && e.message}`);
      return false; // 创建/显示窗口失败 → 调用方回退系统浏览器
    }
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

/* ------------------------------------------------------------------ 通知 */

const TOAST_W = 400;
const TOAST_H = 156;
const TOAST_MAX = 5;

class Notifier {
  constructor(store, getSettings, webViewer) {
    this.store = store;
    this.getSettings = getSettings;
    this.webViewer = webViewer || null;
    this.windows = [];
  }

  /** 有更新时的统一入口：按设置走浮窗 / 原生通知 / 两者。 */
  async push(source, posts) {
    const settings = this.getSettings();
    const mode = settings.notifyMode || 'toast';
    const limit = Math.max(1, Number(settings.notifyLimit) || 3);
    const shown = posts.slice(0, limit);
    if (mode === 'native' || mode === 'both') this.native(source, shown);
    if (mode === 'toast' || mode === 'both') await this.toast(source, shown);
  }

  /** Windows 原生通知。 */
  native(source, posts) {
    if (!Notification.isSupported()) return;
    if (posts.length === 1) {
      const item = posts[0];
      const note = new Notification({
        title: `${source.name} 更新了`,
        body: item.title,
        silent: false,
      });
      note.on('click', () => this.openItem(source, item));
      note.show();
      return;
    }
    const note = new Notification({
      title: `${source.name} 有 ${posts.length} 条更新`,
      body: posts.map((p) => p.title).join('\n').slice(0, 220),
    });
    note.show();
  }

  /** 右下角浮窗（带大图）。 */
  async toast(source, posts) {
    const win = this.createToastWindow(posts.length);
    const payload = encodeURIComponent(JSON.stringify({
      source: { name: source.name, color: source.platformColor, avatar: this.mediaUrl(source.avatar) },
      posts: posts.map((p) => ({
        id: p.id, title: p.title, cover: this.mediaUrl(p.cover), link: p.link,
        time: p.publishedAt, kind: p.kind,
      })),
    }));
    await win.loadFile(path.join(__dirname, '..', 'ui', 'toast.html'), { search: `data=${payload}` });
    this.windows.push(win);
    setTimeout(() => this.closeToast(win), Math.max(6000, 3500 * posts.length));
    return win;
  }

  /** 浮窗窗口：无边框、置顶、右下角堆叠。 */
  createToastWindow(count) {
    const area = screen.getPrimaryDisplay().workAreaSize;
    const height = Math.min(TOAST_H + (Math.min(count, TOAST_MAX) - 1) * 46, 460);
    const offset = this.windows.length * 12;
    const win = new BrowserWindow({
      width: TOAST_W,
      height,
      x: area.width - TOAST_W - 16 - offset,
      y: area.height - height - 16 - offset,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      transparent: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => { this.windows = this.windows.filter((w) => w !== win); });
    return win;
  }

  closeToast(win) {
    if (!win.isDestroyed()) win.close();
  }

  /** 数据目录里的媒体相对路径 → file:// 地址（浮窗走自定义协议，这里直接给 file 地址）。 */
  mediaUrl(rel) {
    if (!rel) return '';
    const abs = path.join(this.store.root, rel);
    return 'file:///' + abs.split(path.sep).join('/').replace(/^\/+/, '');
  }

  openItem(source, item) {
    const target = item.link || source.homeUrl;
    if (!target) return;
    if (this.webViewer && this.webViewer.open(target)) return;
    if (/^https?:\/\//i.test(target)) shell.openExternal(target).catch(() => { /* 打不开就算了 */ });
  }
}

/* -------------------------------------------------------------- 登录窗口 */

class LoginService {
  constructor(registry, notify) {
    this.registry = registry;
    this.notify = notify || (() => {});
    this.win = null;
    this.timer = null;
    this.platformId = null;
  }

  /** 打开平台登录页；由平台确认登录成功后自动保存并关窗。 */
  async open(platformId, cookieNames) {
    const def = this.registry.find(platformId);
    if (!def) throw new Error(`未知平台：${platformId}`);
    this.close();
    const entry = def.login?.entry || `https://${platformId}.com`;
    this.platformId = platformId;
    this.win = new BrowserWindow({
      width: 1080,
      height: 780,
      title: `登录 ${def.name}`,
      autoHideMenuBar: true,
      webPreferences: { partition: BrowserSession.partition(), contextIsolation: true, nodeIntegration: false },
    });
    this.win.loadURL(entry).catch(() => { /* 页面自己会重试 */ });
    // 关窗（无论成功还是用户自己关）都通知界面刷新登录状态
    this.win.on('closed', () => {
      const id = this.platformId;
      this.win = null;
      this.stopTimer();
      this.notify({ platformId: id, closed: true });
    });
    const names = cookieNames || defaultCookieNames(platformId, def);
    this.timer = setInterval(() => this.checkCookies(platformId, def, names), 2000);
    setTimeout(() => this.stopTimer(), 10 * 60 * 1000);
    return { ok: true, message: `登录窗口已打开，在窗口里完成 ${def.name} 登录后会自动保存` };
  }

  /**
   * 轮询 cookie，但**不靠 cookie 名字猜登录**：
   * 抖音这类站点未登录时也会下发 sessionid / passport_csrf_token，
   * 只看 cookie 会在用户登录前就把窗口关掉（这就是「一打开就闪退」的原因）。
   * 所以这里必须让平台自己去校验接口，确认登录成功才保存并关窗。
   */
  async checkCookies(platformId, def, names) {
    if (!this.win || this.win.isDestroyed()) { this.stopTimer(); return; }
    const url = def.login?.cookieUrl || def.login?.entry || '';
    const jar = await BrowserSession.readCookies(url).catch(() => ({}));
    // 没有平台声明的凭证 cookie 时就不用去问接口了（省一次请求）
    if (names.length && !names.some((n) => jar[n])) return;
    this.stopTimer(); // 别让下一轮和这次校验打架
    const verdict = await this.confirmLogin(platformId, def, jar);
    if (!verdict.ok) {
      this.timer = setInterval(() => this.checkCookies(platformId, def, names), 2000);
      return;
    }
    this.registry.saveSession(platformId, { loggedIn: true, cookies: jar, name: verdict.name, at: Date.now() });
    this.notify({ platformId, ok: true, name: verdict.name, message: verdict.message });
    setTimeout(() => this.close(), 1200);
  }

  /** 让平台确认这份 cookie 是否真的登录了。 */
  async confirmLogin(platformId, def, jar) {
    let instance = null;
    try { instance = this.registry.get(platformId); } catch { return { ok: false, message: '平台不可用' }; }
    const previous = instance.loginState;
    instance.loginState = { ...previous, cookies: jar };
    try {
      return await instance.verifyLogin(jar);
    } catch (err) {
      return { ok: false, message: err.message };
    } finally {
      instance.loginState = previous;
    }
  }

  stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  close() {
    this.stopTimer();
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
  }
}

/**
 * 各平台判定「已登录」的凭证 cookie。
 * 优先用平台配置里声明的 cookieNames（自定义平台也走这里），
 * 配置里没写才回落到内置的默认表。
 */
function defaultCookieNames(platformId, def) {
  const declared = def?.login?.cookieNames;
  if (Array.isArray(declared) && declared.length) return declared;
  if (platformId === 'bilibili') return ['SESSDATA', 'DedeUserID'];
  if (platformId === 'douyin') return ['sessionid', 'sessionid_ss', 'sid_tt'];
  return [];
}

/* ---------------------------------------------------------------- 调度 */

class Scheduler {
  constructor(deps) {
    this.registry = deps.registry;
    this.store = deps.store;
    this.notifier = deps.notifier;
    this.emit = deps.emit || (() => {});
    this.log = deps.log || (() => {}); // 采集细节写进日志：0 条时能看出是没截到还是被范围滤掉
    this.browser = deps.browser || null; // 采集用的隐藏窗口，一轮结束后主动关掉
    this.timer = null;
    this.running = false;
    this.startedAt = 0;
  }

  /** 调度器只管按间隔叫醒自己；界面手动刷新走 refreshDue。 */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.refreshDue(), 60 * 1000);
    this.refreshDue();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true; // 让正在跑的这一轮在下一个订阅源处收手
  }

  /** 关掉隐藏采集窗口（没有就跳过），真正关掉才记一行日志。每采完一个源就调一次。 */
  async releaseBrowser() {
    if (!this.browser) return;
    const existed = !!(this.browser.win && !this.browser.win.isDestroyed());
    await this.browser.close().catch(() => { /* 已经关了 */ });
    if (existed) this.log('采集窗口已关闭');
  }

  /** 取出到点的订阅源并开始同步（上一轮没跑完就跳过）。 */
  async refreshDue() {
    if (this.running) return { skipped: true };
    const settings = this.settings();
    const interval = Math.max(5, Number(settings.intervalMinutes) || 20) * 60 * 1000;
    const due = this.sources().filter((s) => s.enabled !== false && Date.now() - (s.lastSyncAt || 0) >= interval);
    if (!due.length) return { skipped: true, due: 0 };
    return this.run(due);
  }

  /** 立即刷新指定订阅源（界面上的「刷新」）。 */
  async refreshNow(sourceId) {
    const all = this.sources();
    const list = all.filter((s) => (sourceId ? s.id === sourceId : true));
    if (!sourceId) return this.run(list.length ? list : all);
    const source = list[0];
    if (!source) return this.run(all);
    // 当前回看范围内已经全量补抓过：走轻量增量（只翻最新一页）即可；
    // 范围扩大了（backfilledDays 不够）才重新深挖，否则 3000 个视频
    // 每次手动检查都要重爬 100+ 页。
    let rangeDays;
    try {
      const platform = this.registry.get(source.platformId);
      rangeDays = Math.min(parseRangeDays(source.range ?? this.settings().range, 15), platform.historyMaxDays);
    } catch { rangeDays = parseRangeDays(this.settings().range, 15); }
    if ((source.backfilledDays || 0) >= rangeDays) return this.run([source]);
    // 单源手动检查 = 补抓模式：把回看范围内的历史一并抓齐
    //（增量只翻最新一页、命中已入库就停，够不到更早的内容）
    return this.run([source], { backfill: true, maxPages: 999, maxItems: 0 });
  }

  /**
   * 单个订阅源按范围回溯一次（添加订阅时的后台任务，或手动补抓更早的历史）。
   * 不通知：回溯到的历史内容不算「更新」。
   * 补抓要翻够页数才能碰到更早的内容，也不能受增量条数上限约束
   * （那两个限制是给每轮增量检查防限流用的）。
   */
  async collectNow(sourceId, range) {
    // 和调度共用一把锁：手动补抓不能和定时同步同时抢同一个隐藏窗口（并发会互相打断、数量对不上）
    if (this.running) return { added: 0, error: null, skipped: true, message: '已有同步在进行，稍后会自动补抓' };
    this.running = true;
    try {
      const list = this.sources();
      const source = list.find((s) => s.id === sourceId);
      if (!source) throw new Error('订阅不存在');
      const result = await this.syncSource(source, {
        rangeOverride: range, notify: false, backfill: true,
        maxPages: 999, maxItems: 0, // 全量：翻页由驱动自己收口（没有更多 / 整页超出范围）
      });
      return {
        added: result.posts.length, error: result.error,
        needLogin: result.needLogin, notice: result.notice || null,
      };
    } finally {
      this.running = false;
      await this.releaseBrowser();
    }
  }

  /** 同步一批订阅源；每个源之间留出间隔，避免同时打满接口被风控。options 透传给 syncSource。 */
  async run(sources, options = {}) {
    if (this.running) return { skipped: true, reason: '上一轮同步还没结束' };
    this.running = true;
    this.startedAt = Date.now();
    this.emit('sync:start', { total: sources.length });
    const added = [];
    const failures = [];
    try {
      for (const source of sources) {
        if (this.stopped) break;
        // 补抓抓到的是历史，不是「更新」：静默入库，不弹通知
        const result = await this.syncSource(source, options.backfill ? { ...options, notify: false } : options);
        if (result.error) failures.push({ sourceId: source.id, message: result.error });
        if (result.needLogin) failures.push({ sourceId: source.id, message: result.needLogin, needLogin: true });
        added.push(...result.posts.map((p) => ({ sourceId: source.id, source })));
        // 每个源采集完就关掉隐藏窗口：避免内存跨账号累积（实测同一窗口复用会让渲染进程从 500MB 涨到 1GB+）
        await this.releaseBrowser();
        await new Promise((r) => setTimeout(r, 1200)); // 源之间留间隔
      }
    } finally {
      this.running = false;
      this.stopped = false;
      // 收尾兜底：循环中间若因 stopped 提前退出，这里再关一次（已关就是 no-op）
      await this.releaseBrowser();
    }
    this.emit('sync:done', { added: added.length, failures });
    return { ok: true, added: added.length, failures, durationMs: Date.now() - this.startedAt };
  }

  /** 单个订阅源：回溯或增量 → 入库 → 直播状态（初次不通知）→ 更新元信息。 */
  async syncSource(source, options = {}) {
    let platform;
    try { platform = this.registry.get(source.platformId); }
    catch (err) {
      // 平台实例化失败（配置坏了等）不该炸掉整轮同步，记为该源的错误即可
      this.markSync(source, { error: err.message });
      return { posts: [], error: err.message };
    }
    const known = new Set(this.store.postsOf(source.id).map((p) => p.id));
    const first = !source.lastSyncAt;
    const wanted = options.rangeOverride ?? source.range ?? this.settings().range;
    const rangeDays = Math.min(parseRangeDays(wanted, 15), platform.historyMaxDays);
    const pages = options.maxPages ?? (first ? 12 : 1);
    const maxItems = options.maxItems ?? (first ? 0 : (Number(this.settings().incrementalLimit) || 12));
    const fresh = []; // 新入库的内容（含逐页提前入库的批次）
    try {
      // 补抓逐页入库：3000 多个视频的回溯翻到一半断掉，已翻的页不至于白翻
      //（最后仍会统一 commit 一次，已入库的按 id 去重自动跳过）
      // 每批入库顺手发事件，界面能边抓边显示，不用等全部翻完。
      const onBatch = options.backfill
        ? (items) => {
            if (!items || !items.length) return;
            fresh.push(...platform.commit(items));
            this.emit('source:updated', { sourceId: source.id, added: fresh.length, partial: true });
          }
        : null;
      const collected = await platform.collect(source, { rangeDays, known, maxPages: pages, maxItems, backfill: !!options.backfill, onBatch });
      if (!collected.ok) {
        this.markSync(source, { error: collected.message });
        this.log(`${source.name || source.id}（${source.platformId}）采集失败：${collected.message}`, 'error');
        return { posts: fresh, error: collected.message, needLogin: collected.needLogin ? collected.message : null };
      }
      // 关键诊断：0 条时要能分清「页面一条都没截到」和「截到了但都早于回看范围」
      this.log(`${source.name || source.id}（${source.platformId}）范围 ${rangeDays} 天：截获 ${collected.raw ?? collected.items.length} 条，入库 ${collected.items.length} 条${collected.notice ? '；' + collected.notice : ''}`);
      fresh.push(...platform.commit(collected.items));
      await this.applyProfile(source, collected.profile);
      const livePost = await this.handleLive(source, collected.live, first);
      if (livePost) fresh.push(livePost);
      // 全量补抓成功：记住这次覆盖的天数，手动检查就不用每次重爬全部
      this.markSync(source, { error: null, backfilledDays: options.backfill ? rangeDays : undefined });
      const shouldNotify = options.notify !== false && !first && fresh.length;
      if (shouldNotify) await this.notifier.push(this.decorate(source), fresh);
      this.emit('source:updated', { sourceId: source.id, added: fresh.length });
      // 「抓到了内容但全被回看范围滤掉」只在做回溯（首次 / 手动补抓）时提示，
      // 增量检查每轮都会遇到范围外的旧作品，次次弹提示反而成了噪音。
      const backfill = options.backfill || !!options.rangeOverride || first;
      return { posts: fresh, error: null, notice: backfill ? (collected.notice || null) : null };
    } catch (err) {
      this.markSync(source, { error: err.message });
      return { posts: fresh, error: err.message }; // 已逐页入库的也算成果
    }
  }

  /** 昵称 / 头像只在拿到新数据时回写，避免每轮都写盘。 */
  async applyProfile(source, profile) {
    const name = profile?.name || (source.name.startsWith('（正在识别') ? source.platformKey.slice(0, 14) : null);
    const avatar = profile?.avatar || null;
    if (!name && !avatar) return;
    const list = this.sources();
    const target = list.find((s) => s.id === source.id);
    if (!target) return;
    if (name === target.name && avatar === target.avatar) return;
    Object.assign(target, { name: name || target.name, avatar: avatar || target.avatar, sign: profile?.sign || target.sign });
    this.saveSources(list);
    this.emit('source:updated', { sourceId: source.id, added: 0 });
  }

  /**
   * 直播状态：仅「未开播 → 开播」这一跳才算更新；首次采集不通知。
   * 直播记录以 live: 前缀入库，因此历史永久保留。
   */
  async handleLive(source, live, first) {
    if (!live) return null;
    const state = this.store.readGlobal('live.json', {});
    const previous = !!state[source.id]?.live;
    state[source.id] = { live: !!live.live, title: live.title, at: Date.now() };
    this.store.writeGlobal('live.json', state);
    if (first || !live.live || previous) return null;
    const post = {
      // 用毫秒时间戳：同一次开播只记一条，下播后再开播是新的记录
      id: `${source.id}:${source.platformId}:live:${Date.now()}`,
      sourceId: source.id,
      platform: source.platformId,
      kind: '直播',
      title: live.title ? `开播：${live.title}` : '开播了',
      body: live.title || '',
      link: live.link || source.homeUrl,
      cover: live.coverUrl ? await this.registry.get(source.platformId).cacheCover(live.coverUrl, `live-${source.id}`) : null,
      coverUrl: live.coverUrl || '',
      author: source.name,
      publishedAt: Date.now(),
      capturedAt: Date.now(),
    };
    this.store.appendPost(post);
    return post;
  }

  /** 给通知用的展示对象。 */
  decorate(source) {
    const platform = this.registry.find(source.platformId);
    return { ...source, platformColor: platform?.color || '#6b7280', homeUrl: source.homeUrl };
  }

  markSync(source, patch) {
    const list = this.sources();
    const target = list.find((s) => s.id === source.id);
    if (!target) return;
    Object.assign(target, { lastSyncAt: Date.now(), lastError: patch.error || null });
    if (patch.backfilledDays) target.backfilledDays = patch.backfilledDays;
    this.saveSources(list);
  }

  /** 订阅对外是一张完整列表，落盘按平台分文件夹（见 store.writeSources）。 */
  sources() { return this.store.readAllSources(); }

  saveSources(list) { this.store.writeSources(list); }

  settings() { return this.store.readGlobal('settings.json', {}); }
}

module.exports = { Notifier, LoginService, Scheduler, WebViewer, defaultCookieNames };