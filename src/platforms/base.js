'use strict';
/**
 * 平台基类：所有平台（内置的 B站 / 抖音，以及用户自定义平台）都走这一套流程。
 * 公共机制（识别链接、按范围回溯、增量抓取、内容入库、直播状态、登录态校验、
 * 媒体本地化）全在这里；子类只实现「怎么问平台要数据」这几个差异点。
 *
 * 统一配置格式（definition）字段：
 *   id / name / color / contentTypes[]        标识与展示
 *   historyMaxDays / supportsRange            历史能力
 *   pageSize / maxPages / pageParam           翻页方式
 *   identifyRules[]                           输入识别规则（第一个捕获组是订阅源 id）
 *   urls.profile / urls.list / urls.detail / urls.live   接口地址
 *   mapper.profile / mapper.list / mapper.item 字段映射（点号路径）
 *   login                                      登录方式、凭证与登录态校验
 *   browser                                    需要隐藏窗口时的页面/选择器
 *   fallback                                   兜底策略（page / screenshot / none）
 */

const path = require('path');
const fs = require('fs');
const net = require('../core/net');

/** 取对象里的点号路径值，支持数组下标；取不到返回 fallback。 */
function pick(obj, dotted, fallback = undefined) {
  if (!dotted) return fallback;
  let cur = obj;
  for (const key of String(dotted).split('.')) {
    if (cur === null || cur === undefined) return fallback;
    cur = cur[key];
  }
  return cur === undefined || cur === null ? fallback : cur;
}

class Platform {
  constructor(definition, context) {
    this.def = definition;
    this.ctx = context; // { store, session, notify, browser }
    this.loginState = (context.session && context.session.login) || {};
  }

  get id() { return this.def.id; }
  get name() { return this.def.name; }
  get color() { return this.def.color || '#6b7280'; }
  get contentTypes() { return this.def.contentTypes || ['视频']; }
  get historyMaxDays() { return this.def.historyMaxDays || 365; }
  get listUrl() { return this.def.urls && this.def.urls.list; }
  get isLoggedIn() { return !!this.loginState.loggedIn; }

  /** 给界面用的元信息，不暴露凭证。 */
  describe() {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      contentTypes: this.contentTypes,
      historyMaxDays: this.historyMaxDays,
      needsLogin: !!this.def.login,
      supportsRange: this.def.supportsRange !== false,
      pageSize: this.def.pageSize || 20,
      order: this.def.order || 'desc',
      builtin: !!this.def.builtin,
      loggedIn: this.isLoggedIn,
      selector: !!this.def.browser,
      fallback: pick(this.def, 'fallback.mode', 'none'),
    };
  }

  /**
   * 输入识别：从链接或 id 里认出订阅源，第一个捕获组就是订阅源 id。
   * 子类可覆盖以支持分享短链等特殊形式（见 DouyinPlatform）。
   */
  async identify(input) {
    const text = String(input || '').trim();
    for (const rule of this.def.identifyRules || defaultIdentifyRules(this.def)) {
      const m = new RegExp(rule.pattern, rule.flags || 'i').exec(text);
      if (m) return { key: m[1], hint: rule.hint || '' };
    }
    return null;
  }

  /** 采集一个订阅源：登录校验 → 用户信息 → 内容列表 → 直播状态。 */
  async collect(source, options = {}) {
    const { rangeDays, known = new Set(), maxItems = 0 } = options;
    if (this.def.login && this.isBlockingLoginGate()) {
      const probe = await this.verifyLogin().catch((err) => ({ ok: false, message: err.message }));
      if (!probe.ok) return { ok: false, needLogin: true, message: this.def.login.hint || '登录态已失效，请重新登录' };
    }
    const profile = await this.fetchProfile(source).catch(() => null);
    const items = await this.fetchItems(source, rangeDays, known, options);
    const live = await this.checkLive(source).catch(() => null);
    const blocked = this.diagnose ? this.diagnose() : null;
    if (blocked && !items.length) return { ok: false, needLogin: true, message: blocked.message };
    return {
      ok: true,
      profile,
      items,
      live,
      // 子类（如抖音）发现「抓到了内容但全被回看范围滤掉」时写 this.rangeNotice，
      // 这里原样带给上层，让界面如实提示而不是静默 0 条。
      notice: !items.length ? (this.rangeNotice || null) : null,
      fallback: items.some((it) => it.fallback) ? 'fallback' : null,
      fetchedAt: Date.now(),
    };
  }

  /**
   * 是否必须「登录才能抓」。
   * 默认是软校验：直接尝试抓取，抓到风控/登录墙的明确信号再让用户去登录，
   * 免得一次网络抖动就把整个订阅标成「登录失效」。
   * 平台配置里写 login.gate = 'hard' 才强制先验证。
   */
  isBlockingLoginGate() {
    return this.def.login?.gate === 'hard';
  }

  /** 用户信息（昵称 / 头像）。子类按需覆盖。 */
  async fetchProfile(source) { return null; }

  /** 视频 / 图文 / 动态 / 文章列表。子类必须实现。 */
  async fetchItems() { throw new Error(`${this.name} 未实现内容列表抓取`); }

  /** 直播开播状态。子类没实现就表示该平台不报直播。 */
  async checkLive() { return null; }

  /**
   * 把平台原始数据整理成统一内容对象，并按需下载封面。
   * 时间一律换算成毫秒；超出回看范围或时间无法判定时返回 null，避免噪音。
   *
   * 内容身份 = 「订阅源 + 平台内标识」。带上订阅源是必须的：
   * 兜底链路（页面解析）拿到的往往只是站点内相对地址（/item/1），
   * 不含订阅源信息，两个不同订阅源会因为同一个 id 而互相顶掉，静默漏内容。
   */
  async stage(source, raw, rangeDays) {
    const publishedAt = toMillis(raw.publishedAt);
    if (!publishedAt) return null;
    if (isFinite(rangeDays) && publishedAt < Date.now() - rangeDays * 86400000) return null;
    const itemId = raw.platformItemId || raw.link || Math.random().toString(36).slice(2);
    const post = {
      id: `${source.id}:${this.id}:${itemId}`,
      sourceId: source.id,
      platform: this.id,
      kind: raw.kind || this.contentTypes[0],
      title: (raw.title || '').trim() || '(无标题)',
      body: (raw.body || '').trim(),
      link: raw.link || '',
      cover: null,
      coverUrl: raw.coverUrl || '',
      author: raw.author || source.name,
      // 抓取时的头像快照：博主以后换了头像，旧内容仍能配当时的头像
      authorAvatar: source.avatar || '',
      publishedAt,
      capturedAt: Date.now(),
      fallback: !!raw.fallback,
    };
    if (raw.coverUrl) post.cover = await this.cacheCover(raw.coverUrl, post.id);
    return post;
  }

  /** 封面快照本地化：原图失效也不影响查看。 */
  async cacheCover(url, postId, referer) {
    const name = postId.replace(/[^\w.-]/g, '_');
    const rel = await net.downloadMedia(url, this.ctx.store.dir(path.join('media', this.id)), name, { referer });
    return rel ? path.relative(this.ctx.store.root, rel).split(path.sep).join('/') : null;
  }

  /**
   * 头像本地化（带版本）：文件名含头像地址的指纹，换头像会存成新文件，
   * **旧头像永久留档、从不覆盖**——头像也是「当时的样子」的一部分。
   * 同一地址已下载过就直接复用，重复同步不重复下载。
   */
  async cacheAvatar(source, url) {
    const base = `${source.platformKey || source.id}`.replace(/[^\w.-]/g, '_');
    const fingerprint = require('crypto').createHash('md5').update(String(url)).digest('hex').slice(0, 8);
    const dir = this.ctx.store.dir(path.join('media', 'avatar', this.id));
    // 已有同指纹文件（任意图片扩展名）直接复用
    try {
      const hit = fs.readdirSync(dir).find((f) => f.startsWith(`${base}-${fingerprint}.`));
      if (hit) return path.relative(this.ctx.store.root, path.join(dir, hit)).split(path.sep).join('/');
    } catch { /* 目录还没建 */ }
    const rel = await net.downloadMedia(url, dir, `${base}-${fingerprint}`);
    return rel ? path.relative(this.ctx.store.root, rel).split(path.sep).join('/') : null;
  }

  /**
   * 把本账号关注的人列出来，让用户直接勾选订阅（比让他去复制主页地址省事）。
   * 默认不支持；子类按平台实现。返回 [{ key, name, avatarUrl, sign }]。
   */
  async fetchFollowings() {
    throw new Error(`${this.name} 还不支持「从我的关注里选」`);
  }

  /** 接口请求头：带 Cookie、Referer，不传 Origin（跨源 Origin 会被拒）。 */
  authHeaders(extra = {}, cookies) {
    const cookie = net.cookieHeader(cookies || this.loginState.cookies);
    return { ...(cookie ? { Cookie: cookie } : {}), ...extra };
  }

  /**
   * 登录态校验：请求校验地址 + 字段路径。
   * 关键：**cookie 存在不等于登录成功**（抖音等站点在未登录时也会下发
   * passport_csrf_token / sessionid 之类的匿名 cookie），所以只信接口结论。
   * cookies 参数用于「刚抓到 cookie、还没落盘时」先验一次。
   */
  async verifyLogin(cookies) {
    const rule = this.def.login || {};
    if (!rule.verifyUrl) {
      // 没配校验接口的平台只能靠「有没有抓到凭证」判断，这时必须显式抓到
      // 平台声明的登录 cookie 才算，不能是任意 cookie。
      const jar = cookies || this.loginState.cookies || {};
      const names = rule.cookieNames || [];
      const ok = names.length > 0 && names.some((n) => !!jar[n]);
      return { ok, message: ok ? '' : (rule.failHint || '还没抓到登录凭证，请先在窗口里完成登录') };
    }
    const res = await net.getJson(rule.verifyUrl, { headers: this.authHeaders({}, cookies) });
    const ok = !!pick(res, rule.verifyPath, false);
    return { ok, message: ok ? '' : (rule.failHint || '登录态已失效'), raw: pick(res, rule.userPath) };
  }

  /** 写库（历史只增不删），返回真正新增的条目。内容身份已在 stage 里带好订阅源。 */
  commit(items) {
    const fresh = [];
    for (const post of items) if (this.ctx.store.appendPost(post)) fresh.push(post);
    return fresh;
  }
}

/** 没写识别规则时按平台域名生成一条宽松规则（自定义平台常用）。 */
function defaultIdentifyRules(def) {
  const host = pick(def, 'urls.list', '');
  const m = /^https?:\/\/([^/]+)/.exec(host);
  if (!m) return [];
  return [{ pattern: `(?:https?://)?${m[1].replace(/\./g, '\\.')}/[^\\s"']*?(\\d+)`, hint: '路径数字 id' }];
}

/** 秒 / 毫秒 / 字符串时间统一成毫秒。 */
function toMillis(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  const num = Number(value);
  if (!Number.isNaN(num) && String(value).trim() !== '') return toMillis(num);
  const parsed = Date.parse(String(value).replace(/\//g, '-'));
  return Number.isNaN(parsed) ? 0 : parsed;
}

module.exports = { Platform, pick, toMillis };
