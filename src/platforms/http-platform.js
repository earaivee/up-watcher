'use strict';
/**
 * 通用 HTTP/JSON 驱动：内置平台自定义平台共用。
 * 该类只认「统一配置格式」，所以用户加的新平台能立刻工作，不需要改代码。
 */

const { Platform, pick, toMillis } = require('./base');
const net = require('../core/net');

class HttpPlatform extends Platform {
  /**
   * 用户信息：按 mapper.profile 的字段路径从接口响应里取。
   * 路径可以直接指向整个用户对象（如 data.user），也可以按字段拆开配
   * （name / face / sign 各自一个路径），两种写法都支持。
   */
  async fetchProfile(source) {
    const url = this.def.urls && this.def.urls.profile;
    if (!url) return null;
    const target = this.buildUrl(url, source);
    const res = await net.getJson(target, { headers: this.authHeaders(this.extraHeaders()) });
    if (!res || (res.code !== undefined && res.code !== 0)) return null;
    return this.readUser(source, res);
  }

  /**
   * 把接口字段整理成界面用的用户信息，顺手把头像下到本地。
   * 支持两种配法：
   *  - 指向整个用户对象：profile: { name: 'data.user' }（其余字段按 name/face/sign 自动找）
   *  - 每个字段各配一条路径：profile: { name: 'data.nickname', face: 'data.avatar' }
   */
  async readUser(source, res) {
    const map = (this.def.mapper && this.def.mapper.profile) || {};
    const bag = this.profileBag(res, map);
    const name = pick(bag, 'name', '') || pick(bag, 'nickname', '') || pick(res, map.name, '') || source.name;
    const avatarUrl = pick(bag, 'face', '') || pick(bag, 'avatar', '') || pick(res, map.face, '');
    const sign = pick(bag, 'sign', '') || pick(res, map.sign, '');
    const user = { name: String(name).trim(), avatarUrl: String(avatarUrl || ''), sign: String(sign || '') };
    if (user.avatarUrl) user.avatar = await this.cacheAvatar(source, user.avatarUrl);
    return user;
  }

  /** 拿到承载用户字段的那个对象：优先用整对象配置，其次退回响应本身。 */
  profileBag(res, map) {
    const node = pick(res, map.name, undefined);
    if (node && typeof node === 'object') return node;
    const parent = pick(res, String(map.name || '').split('.').slice(0, -1).join('.'), undefined);
    return parent && typeof parent === 'object' ? parent : res;
  }

  /**
   * 内容列表：每种内容形式按自己的抓取地址各抓一遍（types[].url），
   * 没配单独地址的形式共用 urls.list；相同地址只请求一次。
   */
  async fetchItems(source, rangeDays, known, options = {}) {
    const { maxItems = 0 } = options;
    const out = [];
    const seen = new Set();
    for (const type of this.typeList()) {
      const url = type.url || this.listUrl;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(...await this.fetchTyped(source, type, rangeDays, known, options));
      if (maxItems && out.length >= maxItems) break;
    }
    return out;
  }

  /** 平台声明的内容形式：types[].name/url 优先，没有就退回单一列表。 */
  typeList() {
    const types = Array.isArray(this.def.types) ? this.def.types.filter((t) => t && t.name) : [];
    return types.length ? types : [{}];
  }

  /** 单一内容形式：按配置翻页，逐页做字段映射。 */
  async fetchTyped(source, type, rangeDays, known, options = {}) {
    const { maxItems = 0, maxPages = this.def.maxPages || 6, onBatch } = options;
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const { items = [], hasMore = false } = (await this.fetchPage(source, page, type)) || {};
      if (!items.length) break;
      let staged = 0;    // 本页真正入库的
      let outOfRange = 0; // 本页因超出回看范围被滤掉的
      const pagePosts = [];
      for (const raw of items) {
        const post = await this.stage(source, raw, rangeDays);
        if (!post) { outOfRange++; continue; }
        if (known.has(post.id)) continue;
        out.push(post);
        pagePosts.push(post);
        staged++;
        if (maxItems && out.length >= maxItems) { onBatch?.(pagePosts); return out; }
      }
      // 这页抓完先落库：回溯中途断掉不至于白翻
      onBatch?.(pagePosts);
      // 列表按时间倒序：整页没有能入库的、还出现了范围外的老内容，
      // 说明更早的页全在范围之外，继续翻只是白打接口。
      if (!staged && outOfRange) break;
      if (!hasMore) break;
    }
    return out;
  }

  /** 列表分页：把翻页参数与范围参数拼进请求地址。 */
  async fetchPage(source, page, type = {}) {
    const url = this.buildUrl(type.url || this.listUrl, source, page);
    const res = await net.getJson(url, { headers: this.authHeaders(this.extraHeaders()) });
    return this.readPage(source, res, page, type);
  }

  /** 按 mapper.list 取出条目数组，并按 mapper.item 映射字段。 */
  readPage(source, res, page, type = {}) {
    const listPath = (this.def.mapper && this.def.mapper.list) || '';
    const raw = pick(res, listPath, null);
    const arr = Array.isArray(raw) ? raw : [];
    const hasMore = this.hasMore(res, arr.length);
    return { items: arr.map((node) => this.mapItem(source, node, type)), hasMore };
  }

  /** 是否还有下一页：优先用配置的字段，其次按「本页取满」推断。 */
  hasMore(res, got) {
    const map = this.def.mapper || {};
    if (map.hasMore) return !!pick(res, map.hasMore, false);
    const pageSize = this.def.pageSize || 20;
    return got >= pageSize;
  }

  /** 字段映射 → 统一内容对象；type 提供形式名与每形式链接模板。 */
  mapItem(source, node, type = {}) {
    const map = (this.def.mapper && this.def.mapper.item) || {};
    const link = this.makeLink(pick(node, map.link, ''), node, type.link);
    const title = pick(node, map.title, '') || pick(node, map.body, '');
    return {
      platformItemId: String(pick(node, map.id, '') || link || ''),
      kind: String(pick(node, map.kind, '') || type.name || this.contentTypes[0]),
      title: String(title || ''),
      body: String(pick(node, map.body, '') || ''),
      link,
      coverUrl: String(pick(node, map.cover, '') || ''),
      publishedAt: toMillis(pick(node, map.time, 0)),
      author: source.name,
    };
  }

  /** 配置里允许用 {key} 占位符拼地址，翻页参数与范围参数自动带上。 */
  buildUrl(template, source, page) {
    const params = { ...(this.def.params || {}) };
    if (this.def.pageParam && page) params[this.def.pageParam] = page;
    if (this.def.listParam && page) params[this.def.listParam] = page;
    if (this.def.rangeParam && this.def.rangeDays) params[this.def.rangeParam] = this.def.rangeDays;
    if (this.def.pageSize) params[this.def.pageSizeParam || 'ps'] = this.def.pageSize;
    let url = String(template || '')
      .replace(/\{sourceKey\}/g, encodeURIComponent(source.platformKey || ''))
      .replace(/\{uid\}/g, encodeURIComponent(source.platformKey || ''))
      .replace(/\{page\}/g, String(page || 1));
    const query = new URLSearchParams(params).toString();
    if (!query) return url;
    return url + (url.includes('?') ? '&' : '?') + query;
  }

  /** 相对链接补全成绝对地址；每形式可用自己的链接模板。 */
  makeLink(link, node, typeTemplate) {
    if (link) return String(link);
    const tpl = typeTemplate || this.def.itemLinkTemplate;
    return tpl ? String(tpl).replace(/\{id\}/g, String(pick(node, 'id', ''))) : '';
  }

  extraHeaders() {
    const headers = {};
    const origin = this.def.originHeader || net.originReferer(this.listUrl || '');
    if (origin) headers.Origin = origin.replace(/\/$/, '');
    return headers;
  }

  /**
   * 通用直播状态：绝大多数站点的直播接口只差「字段路径 + 什么值算在播」，
   * 用配置描述就够，不必为每个平台写代码。
   * live: { url?, mode: 'pathEquals'|'pathTruthy', path, value, titlePath, coverPath, link }
   */
  async checkLive(source) {
    const cfg = this.def.live;
    if (!cfg || !cfg.mode) return null;
    const url = this.buildUrl(cfg.url || this.def.urls?.live, source);
    if (!url) return null;
    const res = await net.getJson(url, { headers: this.authHeaders(this.extraHeaders()) });
    if (!res) return null;
    const value = pick(res, cfg.path);
    const live = cfg.mode === 'pathTruthy' ? !!value : value === cfg.value;
    return {
      live,
      title: String(pick(res, cfg.titlePath, '') || ''),
      coverUrl: String(pick(res, cfg.coverPath, '') || ''),
      link: cfg.link || source.homeUrl || '',
    };
  }
}

module.exports = { HttpPlatform };
