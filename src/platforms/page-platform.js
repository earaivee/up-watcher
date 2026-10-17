'use strict';
/**
 * 通用「页面 / 隐藏窗口」驱动。
 * 用途一：用户新增的自定义平台，不用写代码就能抓（走高级设置里的映射与选择器）；
 * 用途二：接口拿不到数据时的兜底 —— 页面解析 / 截图，兜底条目会被标记，
 *        不能和正常数据混在一起判断「是否被删除」。
 */

const { Platform, toMillis } = require('./base');
const net = require('../core/net');

class PagePlatform extends Platform {
  constructor(definition, context) {
    super(definition, context);
    this.captured = [];
  }

  get session() { return this.ctx.browser; }

  /** 自定义平台的识别规则来自配置，基类已能处理。 */
  async identify(input) {
    const found = await super.identify(input);
    if (found) return found;
    const listUrl = this.def.urls?.list || '';
    const digits = /(\d{4,})/.exec(String(input || ''));
    return digits && listUrl ? { key: digits[1], hint: '路径数字' } : null;
  }

  /** 用户信息：优先走配置的接口，其次用页面选择器。 */
  async fetchProfile(source) {
    if (this.def.urls?.profile) {
      const res = await net.getJson(this.fill(this.def.urls.profile, source),
        { headers: this.authHeaders() });
      if (res && res.code !== -1) return this.readUser(source, pickNode(res, this.def.mapper?.profile));
    }
    if (!this.def.browser) return null;
    const node = await this.readFromDom(this.def.browser.profileSelectors, this.fill(this.def.browser.pageUrl, source));
    return this.readUser(source, node);
  }

  /** 页面选择器 → 用户信息（选择器配置形如 { name: 'h1', face: 'img.avatar@src' }）。 */
  async readUser(source, node) {
    if (!node) return null;
    const name = String(node.name || source.name || '').trim();
    const profile = { name, avatarUrl: node.face || '', sign: String(node.sign || '') };
    if (profile.avatarUrl) profile.avatar = await this.cacheAvatar(source, profile.avatarUrl);
    return profile;
  }

  /**
   * 内容列表：每种内容形式（types[].url）各抓一遍，接口 → 页面解析逐级降级；
   * 没配单独地址的形式共用 urls.list / browser.pageUrl，相同地址只抓一次。
   */
  async fetchItems(source, rangeDays, known, options = {}) {
    const { maxItems = 0 } = options;
    const out = [];
    const seen = new Set();
    for (const type of this.typeList()) {
      const key = type.url || this.def.urls?.list || this.def.browser?.pageUrl || '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const items = await this.fetchOneType(source, type, rangeDays, options);
      for (const post of items) if (!known.has(post.id)) out.push(post);
      if (maxItems && out.length >= maxItems) break;
    }
    return out;
  }

  /** 平台声明的内容形式：types[].name/url 优先，没有就退回单一来源。 */
  typeList() {
    const types = Array.isArray(this.def.types) ? this.def.types.filter((t) => t && t.name) : [];
    return types.length ? types : [{}];
  }

  /** 单一内容形式：先试接口，拿不到再走页面。 */
  async fetchOneType(source, type, rangeDays, options = {}) {
    const { maxItems = 0, maxPages = 6 } = options;
    if ((type.url || this.def.urls?.list) && this.def.mapper?.list) {
      const viaApi = await this.fetchByApi(source, type, rangeDays, maxItems, maxPages);
      if (viaApi.length) return viaApi;
    }
    if (!this.def.browser) return [];
    return this.fetchByPage(source, type, rangeDays, maxItems, options);
  }

  /** 接口方式：按配置请求并做字段映射。 */
  async fetchByApi(source, type, rangeDays, maxItems, maxPages) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const url = this.fill(type.url || this.def.urls.list, source, page);
      const res = await net.getJson(url, { headers: this.authHeaders() });
      const nodes = pickNode(res, this.def.mapper.list) || [];
      if (!Array.isArray(nodes) || !nodes.length) break;
      for (const node of nodes) {
        const post = await this.stage(source, this.mapNode(source, node, type), rangeDays);
        if (post) out.push(post);
        if (maxItems && out.length >= maxItems) return out;
      }
      if (nodes.length < (this.def.pageSize || 20)) break;
    }
    return out;
  }

  /** 字段映射（和 HttpPlatform 同一套语义，便于用户复用配置）。 */
  mapNode(source, node, type = {}) {
    const map = this.def.mapper?.item || {};
    const link = pickNode(node, map.link)
      || String(type.link || this.def.itemLinkTemplate || '').replace(/\{id\}/g, pickNode(node, map.id) || '');
    return {
      platformItemId: String(pickNode(node, map.id) || link || ''),
      kind: String(pickNode(node, map.kind) || type.name || this.contentTypes[0]),
      title: String(pickNode(node, map.title) || pickNode(node, map.body) || ''),
      body: String(pickNode(node, map.body) || ''),
      link,
      coverUrl: String(pickNode(node, map.cover) || ''),
      publishedAt: toMillis(pickNode(node, map.time)),
      author: source.name,
    };
  }

  /** 页面方式：隐藏窗口加载列表页，先取接口响应，取不到再解析 DOM。 */
  async fetchByPage(source, type, rangeDays, maxItems, options) {
    const cfg = this.def.browser || {};
    this.captured = [];
    if (cfg.capture) {
      this.session.capture(cfg.capture, (text) => {
        try { this.captured.push(...(extractArray(JSON.parse(text), this.def.mapper?.list) || [])); } catch { /* 非 JSON */ }
      });
    }
    const pageUrl = this.fill(type.url || cfg.pageUrl || this.def.urls?.list, source);
    await this.session.goto(pageUrl);
    if (cfg.scrollTimes) await this.session.scroll(cfg.scrollTimes, cfg.scrollDelay || 1500);
    if (this.captured.length) {
      const list = this.captured.map((node) => this.mapNode(source, node, type));
      return (await Promise.all(list.map((raw) => this.stage(source, raw, rangeDays)))).filter(Boolean);
    }
    return this.fetchBySelectors(source, type, rangeDays, maxItems, pageUrl);
  }

  /** 最后兜底：页面选择器解析，抓到的数据标记 fallback。 */
  async fetchBySelectors(source, type, rangeDays, maxItems, pageUrl) {
    const cfg = this.def.browser || {};
    const rows = await this.readFromDom(cfg.itemSelectors, pageUrl, true);
    const list = (Array.isArray(rows) ? rows : []).map((row) => ({
      platformItemId: row.link || row.title,
      kind: type.name || this.contentTypes[0],
      title: row.title,
      body: row.body || '',
      link: absolute(row.link, pageUrl),
      coverUrl: absolute(row.cover, pageUrl),
      publishedAt: toMillis(row.time || Date.now()),
      author: source.name,
      fallback: true,
    }));
    const staged = [];
    for (const raw of list) {
      const post = await this.stage(source, raw, rangeDays);
      if (post) staged.push(post);
      if (maxItems && staged.length >= maxItems) break;
    }
    // 截图兜底已接线：靠选择器抓到内容时留一张页面快照，
    // 挂在第一条内容上，详情面板可查看——用于确认「抓的确实是那一页」
    if (staged.length && this.def.fallback?.mode === 'screenshot') {
      const shot = await this.captureScreenshot(source).catch(() => null);
      if (shot) staged[0].screenshot = shot;
    }
    return staged;
  }

  /**
   * 用选择器读页面。selectors 形如 { item: 'li.card', title: 'h3', time: 'time@datetime' }，
   * 传 list=true 表示按条目重复读取。
   */
  async readFromDom(selectors, pageUrl, list = false) {
    if (!selectors) return list ? [] : null;
    if (pageUrl) await this.session.goto(pageUrl);
    const script = buildExtractScript(selectors, list);
    return this.session.eval(script);
  }

  /** 兜底拿到内容时留一张页面截图，便于用户确认抓的是不是那一页。 */
  async captureScreenshot(source) {
    if (this.def.fallback?.mode !== 'screenshot') return null;
    const dir = this.ctx.store.dir('media/screenshot');
    const image = await this.session.win.webContents.capturePage();
    const file = require('path').join(dir, `${source.id}-${Date.now()}.png`);
    await require('fs/promises').writeFile(file, image.toPNG());
    return require('path').relative(this.ctx.store.root, file).split(require('path').sep).join('/');
  }

  /** 把 {sourceKey} / {key} / {page} 占位符换成真实值。 */
  fill(template, source, page) {
    const params = { ...(this.def.params || {}) };
    if (page && this.def.pageParam) params[this.def.pageParam] = page;
    let url = String(template || '')
      .replace(/\{sourceKey\}/g, encodeURIComponent(source.platformKey || ''))
      .replace(/\{key\}/g, encodeURIComponent(source.platformKey || ''))
      .replace(/\{page\}/g, String(page || 1));
    const query = new URLSearchParams(params).toString();
    if (query && !url.includes('{')) url += (url.includes('?') ? '&' : '?') + query;
    return url;
  }

  async checkLive() { return null; }
}

/** 从任意 JSON 里按点号路径找出第一个数组（用户不写路径时也能用）。 */
function extractArray(json, path) {
  const hit = pickNode(json, path);
  if (Array.isArray(hit)) return hit;
  const stack = [json];
  while (stack.length) {
    const cur = stack.shift();
    if (!cur || typeof cur !== 'object') continue;
    for (const value of Object.values(cur)) {
      if (Array.isArray(value) && value.length && typeof value[0] === 'object') return value;
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return null;
}

/** 点号路径取值。 */
function pickNode(node, path) {
  if (!path) return node;
  let cur = node;
  for (const key of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 生成在页面上下文里跑的选择器提取脚本（选择器支持 tag@attr）。 */
function buildExtractScript(selectors, list) {
  const spec = JSON.stringify(selectors);
  return `(() => {
    const sel = ${spec};
    const read = (root, expr) => {
      if (!expr) return '';
      const [q, attr] = String(expr).split('@');
      const el = q ? root.querySelector(q) : root;
      if (!el) return '';
      if (attr === 'text') return (el.innerText || '').trim();
      return attr ? (el.getAttribute(attr) || '') : ((el.innerText || el.src || '').trim());
    };
    if (${!!list}) {
      return [...document.querySelectorAll(sel.item || 'body')].slice(0, 200).map((el) => ({
        title: read(el, sel.title), body: read(el, sel.body), link: read(el, sel.link),
        cover: read(el, sel.cover), time: read(el, sel.time),
      })).filter((row) => row.title || row.link);
    }
    return { name: read(document, sel.name), face: read(document, sel.face), sign: read(document, sel.sign) };
  })()`;
}

/** 相对地址补成绝对地址。 */
function absolute(url, base) {
  try { return new URL(url, base).href; } catch { return url || ''; }
}

module.exports = { PagePlatform, pickNode, extractArray };
