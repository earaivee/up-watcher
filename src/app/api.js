'use strict';
/**
 * IPC 接口层。界面能做的事全在这里，每个通道一个 handle，逻辑尽量薄，
 * 真正的机制在 platforms / services 里。
 */

const { ipcMain, shell } = require('electron');
const { parseRangeDays } = require('../core/net');
const { CUSTOM_TEMPLATE } = require('../platforms/definitions');
const autostart = require('./autostart');

/** 首次添加订阅时的默认设置。 */
const DEFAULT_SETTINGS = {
  range: '15天',
  intervalMinutes: 20,
  incrementalLimit: 12,
  notifyMode: 'toast',
  notifyLimit: 3,
  openAtLogin: false,
};

class Api {
  constructor(app) {
    this.app = app; // { store, registry, scheduler, notifier, login, browser, emit }
  }

  register() {
    const routes = {
      'app:bootstrap': () => this.bootstrap(),
      'settings:get': () => this.settings(),
      'settings:save': (patch) => this.saveSettings(patch),
      'platforms:list': () => this.app.registry.list(),
      'platforms:template': () => CUSTOM_TEMPLATE,
      'platforms:get': (id) => this.app.registry.find(id),
      'platforms:save': (def) => this.savePlatform(def),
      'platforms:remove': (id) => this.removePlatform(id),
      'platforms:test': (payload) => this.testPlatform(payload),
      'sources:list': () => this.app.scheduler.sources().map((s) => this.decorateSource(s)),
      'sources:add': (input) => this.addSource(input),
      'sources:update': (patch) => this.updateSource(patch),
      'sources:remove': (id) => this.removeSource(id),
      'sources:collect': (payload) => {
        const p = typeof payload === 'string' ? { id: payload } : (payload || {});
        return this.app.scheduler.collectNow(p.id, p.range || null);
      },
      'sources:sync': (id) => this.app.scheduler.refreshNow(id),
      'sources:loginState': (id) => this.checkLogin(id),
      'sources:login': (id) => this.login(id),
      'sources:followings': (id) => this.followings(id),
      'posts:list': (query) => this.listPosts(query),
      'posts:reveal': (relPath) => this.revealPosts(relPath),
      'posts:snapshot': (payload) => this.snapshotPost(payload),
      'data:reveal': () => shell.openPath(this.app.store.root),
      'data:stats': () => this.stats(),
      // 链接一律进内置浏览器（与登录/抓取共用会话分区，自带登录态）；
      // 非网页地址（如本地文件）才交给系统处理。
      // 返回实际打开方式，界面据此提示，诊断日志见数据目录 open-link.log。
      'shell:open': (url) => {
        if (!url) return { mode: 'none' };
        if (this.app.webViewer && this.app.webViewer.open(url)) return { mode: 'viewer' };
        shell.openExternal(url).catch(() => {});
        return { mode: 'external' };
      },
      'sync:now': () => this.app.scheduler.refreshNow(),
      // 开机自启单独走：它是系统级设置，要立刻生效并立刻回读真实状态，
      // 不能等到用户点「保存」才写——写失败（安全软件拦截）得马上告诉用户。
      'autostart:get': () => autostart.get(),
      'autostart:set': (enabled) => this.setAutoStart(!!enabled),
      'log:open': () => this.openLog(),
    };
    for (const [channel, handler] of Object.entries(routes)) {
      ipcMain.handle(channel, async (_event, payload) => this.guard(() => handler(payload)));
    }
    this.app.emit = (name, data) => this.broadcast(name, data);
  }

  /** 统一把异常变成 { ok:false, error }，界面永远拿得到可读信息。 */
  async guard(fn) {
    try {
      const data = await fn();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  broadcast(name, data) {
    this.log(`事件 ${name}`); // 界面能看到的，日志里也留一份（界面刷新之后日志就是唯一现场）
    for (const win of this.app.windows()) {
      if (!win.isDestroyed()) win.webContents.send('event', { name, data });
    }
  }

  /** 界面首屏需要的全部状态，一次拿完。 */
  bootstrap() {
    return {
      settings: this.settings(),
      platforms: this.app.registry.list(),
      sources: this.app.scheduler.sources().map((s) => this.decorateSource(s)),
      dataRoot: this.app.store.root,
      running: this.app.scheduler.running,
      autoLaunch: autostart.get(), // 系统里的真实状态，界面开关以它为准
      logFile: this.app.logger ? this.app.logger.file : null,
      version: require('../../package.json').version, // 界面显示版本号，方便确认跑的是不是新版
    };
  }

  settings() {
    return { ...DEFAULT_SETTINGS, ...this.app.store.readGlobal('settings.json', {}) };
  }

  saveSettings(patch) {
    const next = { ...this.settings(), ...patch };
    this.app.store.writeGlobal('settings.json', next);
    this.app.emit('settings:changed', next);
    this.log(`设置已保存 回看=${next.range} 间隔=${next.intervalMinutes}分 通知=${next.notifyMode} 开机自启=${!!next.openAtLogin}`);
    return next;
  }

  /** 在资源管理器里打开本次运行的日志（排错时用户能直接把文件发出来）。 */
  openLog() {
    const file = this.app.logger && this.app.logger.file;
    if (!file || !require('fs').existsSync(file)) throw new Error('日志文件还没生成');
    shell.openPath(file);
    return file;
  }

  /** 日志：只记动作与结果，不记抓到的内容，也不记 cookie。 */
  log(msg, level = 'info') {
    const logger = this.app.logger;
    if (!logger) return;
    if (typeof logger[level] === 'function') logger[level](msg);
    else logger.info(msg);
  }

  /**
   * 开机自启开关：写系统启动项 + 回读真实状态，并把结果落进 settings.json
   * （界面可能因安全软件拦截而失败，此时以系统实际状态为准写回，界面不会「显示开了其实没开」）。
   */
  setAutoStart(enabled) {
    let info;
    try {
      info = autostart.set(enabled);
    } catch (err) {
      this.log(`开机自启设置失败（${enabled ? '开启' : '关闭'}）：${err.message}`, 'error');
      throw err;
    }
    this.app.store.writeGlobal('settings.json', { ...this.settings(), openAtLogin: info.enabled });
    this.app.emit('settings:changed', this.settings());
    this.log(`开机自启已${info.enabled ? '开启' : '关闭'}`);
    return info;
  }

  savePlatform(def) {
    const saved = this.app.registry.save(def);
    this.app.emit('platforms:changed', saved);
    return saved;
  }

  removePlatform(id) {
    const ok = this.app.registry.remove(id);
    this.app.emit('platforms:changed', { id, removed: true });
    return ok;
  }

  /**
   * 用一份（还没保存的）配置试抓一次，让普通用户改完配置能立刻知道对不对。
   * 只读操作：不写盘、不入库、不发通知。
   */
  async testPlatform(payload) {
    const def = payload && payload.definition;
    if (!def || !def.id) throw new Error('配置缺少平台标识');
    const raw = payload.input || '';
    const { createPlatform } = require('../platforms/registry');
    const platform = createPlatform(def, {
      store: this.app.store,
      browser: this.app.browser,
      notify: () => {},
      session: { login: this.app.registry.loadSession(def.id) },
      log: (msg, level) => this.log(msg, level),
    });
    const input = String(raw).trim();
    const found = input ? await platform.identify(input) : null;
    if (input && !found) {
      return { ok: false, step: 'identify', message: `认不出这个输入，检查「输入识别规则」是否匹配：${input}` };
    }
    const source = {
      id: 'test-preview', platformId: def.id, platformKey: (found && found.key) || 'test',
      name: def.name || '测试', contentTypes: def.contentTypes || ['视频'],
    };
    const collected = await platform.collect(source, { rangeDays: 3650, known: new Set(), maxItems: 5 });
    if (!collected.ok) return { ok: false, step: 'collect', message: collected.message || '采集失败' };
    return {
      ok: true,
      step: 'done',
      profile: collected.profile ? collected.profile.name : null,
      live: collected.live ? { live: collected.live.live, title: collected.live.title } : null,
      items: collected.items.slice(0, 3).map((p) => ({ title: p.title, kind: p.kind, link: p.link, hasCover: !!p.cover })),
      total: collected.items.length,
    };
  }

  /**
   * 添加订阅：只做「识别 + 建档 + 立刻返回」，昵称 / 头像 / 回溯历史全放后台。
   * 这样界面不用等网络。
   */
  async addSource(input) {
    const text = String(input?.input ?? input ?? '').trim();
    if (!text) throw new Error('请填写要订阅的主页地址或 id');
    const platformId = input?.platformId || await this.identifyPlatform(text);
    const platform = this.app.registry.get(platformId);
    const found = await platform.identify(text);
    if (!found) throw new Error(`认不出这个输入，${platform.name} 需要主页地址或用户 id`);
    const list = this.app.scheduler.sources();
    if (list.some((s) => s.platformId === platformId && s.platformKey === found.key)) {
      throw new Error('这个博主已经在订阅列表里了');
    }
    const source = this.buildSource(input, platformId, platform, found);
    list.push(source);
    this.app.scheduler.saveSources(list);
    this.app.emit('source:added', source);
    this.log(`新增订阅 ${platform.name}/${found.key}`);
    this.backgroundCollect(source, input?.range || this.settings().range); // 不阻塞界面
    return source;
  }

  /** 组装订阅记录：内容形式与回看范围默认跟随平台 / 全局设置。 */
  buildSource(input, platformId, platform, found) {
    return {
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      platformId,
      platformKey: found.key,
      name: input?.name || '（正在识别…）',
      avatar: null,
      sign: '',
      homeUrl: homeUrlOf(platform, found.key),
      contentTypes: input?.contentTypes?.length ? input.contentTypes : platform.contentTypes,
      range: input?.range || null,
      enabled: true,
      createdAt: Date.now(),
      lastSyncAt: 0,
      lastError: null,
    };
  }

  /** 依次试各平台的识别规则，第一个认出来的为准。 */
  async identifyPlatform(text) {
    const definitions = this.app.registry.list();
    for (const def of definitions) {
      const platform = this.app.registry.get(def.id);
      if (await platform.identify(text)) return def.id;
    }
    throw new Error('所有平台都认不出这个输入，可以到「自定义平台」里加一个规则');
  }

  /** 后台回溯：识别昵称、下载头像、按范围补历史，完成后通知界面刷新。 */
  backgroundCollect(source, range) {
    const task = async () => {
      const result = await this.app.scheduler.collectNow(source.id, range);
      this.app.emit('collect:done', { sourceId: source.id, ...result });
    };
    task().catch((err) => {
      this.log(`回溯失败 ${source.name || source.id}：${err.message}`, 'error');
      this.app.emit('collect:failed', { sourceId: source.id, message: err.message });
    });
  }

  updateSource(patch) {
    const list = this.app.scheduler.sources();
    const target = list.find((s) => s.id === patch.id);
    if (!target) throw new Error('订阅不存在');
    // 回看范围是否扩大：增量刷新只翻最新一页、命中已入库就停，
    // 永远够不到更早的历史——范围扩大时直接在后台补一次抓，不用等用户手动刷新。
    const oldDays = parseRangeDays(target.range ?? this.settings().range);
    const newDays = patch.range !== undefined
      ? parseRangeDays(patch.range ?? this.settings().range)
      : oldDays;
    Object.assign(target, patch);
    this.app.scheduler.saveSources(list);
    this.app.emit('source:updated', { sourceId: target.id });
    if (newDays > oldDays && target.enabled !== false) {
      this.backgroundCollect(target, patch.range ?? this.settings().range);
    }
    return target;
  }

  removeSource(id) {
    const list = this.app.scheduler.sources().filter((s) => s.id !== id);
    this.app.scheduler.saveSources(list);
    this.app.emit('source:removed', { sourceId: id });
    return true;
  }

  /** 内容列表：支持按订阅源 / 平台 / 形式过滤，永远按发布时间倒序。 */
  listPosts(query = {}) {
    const sources = new Map(this.app.scheduler.sources().map((s) => [s.id, s]));
    const limit = Number(query.limit) || 300;
    const out = [];
    for (const source of sources.values()) {
      if (query.sourceId && source.id !== query.sourceId) continue;
      if (query.platformId && source.platformId !== query.platformId) continue;
      for (const post of this.app.store.postsOf(source.id)) {
        if (query.kind && post.kind !== query.kind) continue;
        if (query.keyword && !`${post.title}${post.body}`.includes(query.keyword)) continue;
        out.push(this.decoratePost(post, source));
      }
    }
    out.sort((a, b) => b.publishedAt - a.publishedAt);
    return { total: out.length, items: out.slice(0, limit) };
  }

  /** 补上界面要用的来源名与本地媒体地址。 */
  decoratePost(post, source) {
    return {
      ...post,
      sourceName: source?.name || post.author,
      platformId: post.platform || source?.platformId,
      coverFile: this.mediaUrl(post.cover),
      // 优先用入库时的头像快照（博主换头像后旧内容仍显示当时的头像），没有再回退当前头像
      avatarFile: this.mediaUrl(post.authorAvatar || source?.avatar || ''),
    };
  }

  /** 订阅数据补上本地头像地址：落盘的 avatar 是相对路径，界面直接当 src 用会 404。 */
  decorateSource(source) {
    return { ...source, avatarFile: this.mediaUrl(source.avatar || '') };
  }

  mediaUrl(rel) {
    if (!rel) return '';
    const path = require('path');
    const abs = path.join(this.app.store.root, rel);
    return 'file:///' + abs.split(path.sep).join('/').replace(/^\/+/, '');
  }

  revealPosts(relPath) {
    const path = require('path');
    if (!relPath) throw new Error('没有本地文件');
    const full = path.join(this.app.store.root, relPath);
    if (!require('fs').existsSync(full)) throw new Error('本地文件不存在（' + relPath + '）');
    shell.showItemInFolder(full);
    return true;
  }

  /**
   * 给没有封面的旧内容补一张「动态快照」：
   * 隐藏窗口打开内容原文链接截整页，存为本地封面，并把结果追加进历史
   * （upsert 同 id 更新行，历史行不删）。完成后界面按钮自动从「截取」切成「查看」。
   */
  async snapshotPost(payload) {
    const path = require('path');
    const fs = require('fs');
    const { id, link } = payload || {};
    const post = this.app.store.getPost(id);
    if (!post) throw new Error('找不到这条内容');
    if (post.cover) return { cover: post.cover, message: '已有封面快照' };
    if (!link && !post.link) throw new Error('这条内容没有原文链接，无法截图');
    // 隐藏抓取窗口是共享的，同步进行中不能抢（goto 会打断进行中的抓取）
    if (this.app.scheduler && this.app.scheduler.running) {
      throw new Error('正在同步订阅，请稍后再试');
    }
    const target = link || post.link;
    const png = await this.app.browser.captureScreenshot(target);
    if (!png || png.length < 2000) throw new Error('截图失败（页面没加载出来），请稍后重试');
    const itemId = String(id).split(':').slice(2).join(':').replace(/[^\w.-]/g, '_') || 'item';
    const rel = `media/${post.platform || 'misc'}/shot-${itemId}.png`;
    const full = path.join(this.app.store.root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, png);
    this.app.store.upsertPost({ ...post, cover: rel, snapshotAt: Date.now() });
    return { cover: rel };
  }

  stats() {
    const sources = this.app.scheduler.sources();
    const posts = sources.reduce((sum, s) => sum + this.app.store.postsOf(s.id).length, 0);
    let bytes = 0;
    try {
      const walk = (dir) => {
        for (const entry of require('fs').readdirSync(dir, { withFileTypes: true })) {
          const full = require('path').join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else bytes += require('fs').statSync(full).size;
        }
      };
      walk(this.app.store.root);
    } catch { /* 目录读不到就只报条数 */ }
    return { sources: sources.length, posts, mediaMb: +(bytes / 1048576).toFixed(1), dataRoot: this.app.store.root };
  }

  async checkLogin(platformId) {
    const platform = this.app.registry.get(platformId);
    if (!platform.def.login) return { ok: true, message: '该平台不需要登录' };
    const result = await platform.verifyLogin();
    // B站等重写的 verifyLogin 返回 name；通用实现把昵称放在 raw（userPath 取出）
    this.app.registry.saveSession(platformId, {
      loggedIn: !!result.ok, name: result.name || result.raw || '', at: Date.now(),
    });
    this.app.emit('login:changed', { platformId, ok: result.ok });
    return { ...result, name: result.name || result.raw || '' };
  }

  /** 打开登录窗口；窗口负责抓 cookie 并回存。 */
  async login(platformId) {
    const def = this.app.registry.find(platformId);
    if (!def?.login) throw new Error('该平台没有配置登录入口');
    return this.app.login.open(platformId);
  }

  /**
   * 列出本账号关注的人，让用户直接勾选订阅。
   * 需要登录；登录态失效时给出明确提示，不返回空列表糊弄人。
   */
  async followings(platformId) {
    const platform = this.app.registry.get(platformId);
    if (!platform.def.login) throw new Error(`${platform.name} 不需要登录，直接粘贴主页地址订阅即可`);
    const session = this.app.registry.loadSession(platformId);
    platform.loginState = session;
    const list = await platform.fetchFollowings();
    return { platformId, total: list.length, items: list };
  }
}

/** 订阅源主页地址：优先用配置里的模板，否则用识别出的 id 拼一个。 */
function homeUrlOf(platform, key) {
  const tpl = platform.def.homeUrl || platform.def.browser?.pageUrl || platform.def.urls?.list || '';
  if (tpl.includes('{sourceKey}') || tpl.includes('{key}')) {
    return tpl.replace(/\{sourceKey\}|\{key\}/g, encodeURIComponent(key));
  }
  return tpl;
}

module.exports = { Api, DEFAULT_SETTINGS, parseRangeDays };
