'use strict';
/**
 * 平台注册表：统一配置格式的持久化 + 驱动实例化。
 * 用户改过的内置平台配置也会被保存，重启后依然是改过的版本。
 */

const { BiliPlatform } = require('./bilibili');
const { DouyinPlatform } = require('./douyin');
const { HttpPlatform } = require('./http-platform');
const { PagePlatform } = require('./page-platform');
const { builtinDefinitions, CUSTOM_TEMPLATE, DEFINITIONS_VERSION } = require('./definitions');

const FILE = 'platforms.json';

class Registry {
  constructor(store, deps = {}) {
    this.store = store;
    this.deps = deps; // { browser, notify, log }
    this.log = deps.log || (() => {}); // 透传给每个平台驱动，采集过程才能写日志
    this.defs = this.loadDefinitions();
    this.instances = new Map();
  }

  /**
   * 读取平台定义；内置定义升级（或缺失）时按 id 合并，保留用户的改动结果。
   * 按字段合并（内置打底、存档覆盖）：给内置平台新增字段（如 gridRatio）
   * 时，旧存档里没有该字段也不会把新配置吞掉。
   */
  loadDefinitions() {
    const saved = this.store.readGlobal(FILE, null);
    const builtin = builtinDefinitions();
    if (!saved || saved.version !== DEFINITIONS_VERSION) return builtin;
    const byId = new Map((saved.platforms || []).map((d) => [d.id, d]));
    return [
      ...builtin.map((d) => {
        const user = byId.get(d.id);
        return user ? { ...d, ...user } : d; // 内置打底，用户改动覆盖
      }),
      ...(saved.platforms || []).filter((d) => !d.builtin), // 用户自定义平台
    ];
  }

  persistDefinitions() { this.store.writeGlobal(FILE, { version: DEFINITIONS_VERSION, platforms: this.defs }); }

  list() { return this.defs.map((d) => this.describe(d)); }

  find(id) { return this.defs.find((d) => d.id === id) || null; }

  /** 把驱动实例化成界面可用的描述（不含凭证）。 */
  describe(def) {
    return {
      id: def.id,
      name: def.name,
      color: def.color || '#6b7280',
      contentTypes: def.contentTypes || ['视频'],
      historyMaxDays: def.historyMaxDays || 365,
      gridRatio: def.gridRatio || '', // 图墙封面默认宽高比（如 16:9 / 9:16）
      needsLogin: !!def.login,
      loggedIn: !!this.loadSession(def.id).loggedIn,
      builtin: !!def.builtin,
      driver: classify(def),
    };
  }

  /** 新增或覆盖平台定义（内置也允许改）。 */
  save(definition) {
    if (!definition || !definition.id) throw new Error('平台标识不能为空');
    const existing = this.defs.findIndex((d) => d.id === definition.id);
    if (existing >= 0) {
      definition.builtin = this.defs[existing].builtin; // 内置身份不可被自定义覆盖
      this.defs[existing] = { ...this.defs[existing], ...definition };
    } else {
      this.defs.push({ ...CUSTOM_TEMPLATE, ...definition, builtin: false });
    }
    this.persistDefinitions();
    this.instances.delete(definition.id);
    return this.describe(this.find(definition.id));
  }

  /** 删除自定义平台；顺手清掉它下面的订阅源，免得留下「未知平台」的孤儿订阅。 */
  remove(id) {
    const def = this.find(id);
    if (!def) return false;
    if (def.builtin) throw new Error('内置平台不能删除，只能修改配置');
    this.defs = this.defs.filter((d) => d.id !== id);
    this.persistDefinitions();
    this.instances.delete(id);
    const sources = this.store.readAllSources();
    const kept = sources.filter((s) => s.platformId !== id);
    if (kept.length !== sources.length) this.store.writeSources(kept);
    return true;
  }

  /** 取驱动实例（带缓存），并把登录态与回存回调接上。 */
  get(id) {
    if (this.instances.has(id)) return this.instances.get(id);
    const def = this.find(id);
    if (!def) throw new Error(`未知平台：${id}`);
    const platform = createPlatform(def, {
      store: this.store,
      browser: this.deps.browser,
      notify: this.deps.notify,
      session: this.sessionFacade(id),
      log: this.log,
    });
    this.instances.set(id, platform);
    return platform;
  }

  /** 登录态门面：读盘 + 落盘，平台只需关心凭证对象本身。 */
  sessionFacade(id) {
    const session = this.loadSession(id);
    return {
      get login() { return session; },
      save: (patch) => {
        Object.assign(session, patch);
        this.store.writeSession(id, session);
        const platform = this.instances.get(id);
        if (platform) platform.loginState = session;
      },
    };
  }

  loadSession(id) {
    // 读不到时给出统一默认形状，调用方不用处处判空
    return { loggedIn: false, cookies: {}, savedAt: 0, ...this.store.readSession(id) };
  }

  /** 登录窗口抓到凭证后落盘，并让驱动立刻用上新登录态。 */
  saveSession(id, patch) {
    const session = { ...this.loadSession(id), ...patch, savedAt: Date.now() };
    this.store.writeSession(id, session);
    const platform = this.instances.get(id);
    if (platform) platform.loginState = session;
    return session;
  }
}

/** 按定义判断该用哪个驱动：显式声明优先，否则按能否做 JSON 映射推断。 */
function classify(def) {
  if (def.driver === 'http' || def.driver === 'browser' || def.driver === 'generic') return def.driver;
  if (def.urls?.list && def.mapper?.list) return 'http';
  return def.browser ? 'generic' : 'http';
}

/** 驱动工厂。 */
function createPlatform(def, context) {
  const driver = classify(def);
  if (driver === 'browser' || def.id === 'douyin') return new DouyinPlatform(def, context);
  if (def.id === 'bilibili') return new BiliPlatform(def, context);
  if (driver === 'http') return new HttpPlatform(def, context);
  return new PagePlatform(def, context);
}

module.exports = { Registry, createPlatform, classify, CUSTOM_TEMPLATE, DEFINITIONS_VERSION };
