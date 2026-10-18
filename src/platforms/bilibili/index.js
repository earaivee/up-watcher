'use strict';
/**
 * B站驱动。
 * 接口与坑（需求文档第 4 节）：
 *  - 用户信息 /x/space/wbi/acc/info（失败退 /x/web-interface/card，该接口不需要 WBI）
 *  - 视频列表 /x/space/wbi/arc/search（pn 翻页）
 *  - 动态（含图文 / 专栏）/x/polymer/web-dynamic/v1/feed/space（offset 翻页）
 *  - 每条动态再用 /x/polymer/web-dynamic/v1/detail 复核，-404 精确判定已删除
 *  - 直播 /room/v1/Room/get_info（room_id 只需取一次，之后缓存）
 */

const path = require('path');
const { Platform, pick, toMillis } = require('../base');
const net = require('../../core/net');
const { RiskGuard, signParams } = require('./risk');

const KINDS = ['视频', '动态', '图文', '专栏文章'];

class BiliPlatform extends Platform {
  constructor(definition, context) {
    super(definition, context);
    this.guard = new RiskGuard();
    this.roomIds = new Map();   // uid → room_id，取一次即可
    this.emptyStreak = 0;       // 连续空页次数（仅用于重试/日志，不再直接判定风控）
    this.riskSignal = 0;        // 真正出现 -412 / -403 风控错误码的次数
    this.snapshotBudget = 0;    // 本轮还允许几张「无图动态截图封面」，避免拖慢同步
  }

  get contentTypes() { return KINDS; }
  get historyMaxDays() { return 3650; }

  /** 识别空间地址。 */
  async identify(input) {
    const text = String(input || '').trim();
    if (/^\d+$/.test(text)) return { key: text, hint: 'UID' };
    const m = /space\.bilibili\.com\/(\d+)/i.exec(text);
    return m ? { key: m[1], hint: 'UID' } : null;
  }

  /**
   * 从「我的关注」里取人：/x/relation/followings 需要登录，用 vmid + pn 翻页。
   * 一次只取前几页，够用户挑就行。
   */
  async fetchFollowings(options = {}) {
    if (!this.isLoggedIn) throw new Error('请先登录 B站，再点「从我的关注里选」');
    const me = await this.verifyLogin();
    const vmid = me.mid || this.loginState.mid;
    if (!vmid) throw new Error('拿不到你的 UID，请重新登录 B站');
    const out = [];
    const pageSize = options.pageSize || 50;
    for (let pn = 1; pn <= (options.maxPages || 4); pn++) {
      const res = await this.api('/x/relation/followings',
        { vmid, pn, ps: pageSize, order: 'desc', order_type: 'attention' }, { platformKey: String(vmid) }, true);
      const list = res?.data?.list || [];
      const total = Number(res?.data?.total || 0);
      for (const user of list) {
        out.push({
          key: String(user.mid),
          name: user.uname || String(user.mid),
          avatarUrl: normalizeUrl(user.face || ''),
          sign: user.sign || '',
        });
      }
      if (out.length >= total || list.length < pageSize) break;
    }
    return out;
  }

  /** 用户信息；wbi 接口失败时退回不需要签名的 card 接口。 */
  async fetchProfile(source) {
    const info = await this.api('/x/space/wbi/acc/info', { mid: source.platformKey, platform: 'web' }, source, true);
    let node = info?.code === 0 ? info.data : null;
    if (!node) {
      const card = await net.getJson(`https://api.bilibili.com/x/web-interface/card?mid=${source.platformKey}`,
        { headers: this.headers(source) });
      node = card?.code === 0 ? card.data?.card : null;
      this.log(`wbi 资料接口没数据，改用 card 接口：${node ? '拿到' : '也没有'}`, node ? 'info' : 'warn');
    }
    return node ? this.readUser(source, node) : null;
  }

  /** WBI 接口：加签名 + 指纹参数；-352 刷新指纹重试一次自愈。 */
  async api(endpoint, params, source, signed = false) {
    const ctx = await this.guard.get(this.loginState);
    const query = signed
      ? signParams({ ...params, ...this.guard.fingerprint() }, ctx.mixinKey[0], ctx.mixinKey[1])
      : new URLSearchParams(params).toString();
    const t0 = Date.now();
    let res;
    try {
      res = await net.getJson(`https://api.bilibili.com${endpoint}?${query}`, { headers: this.headers(source, ctx) });
    } catch (err) {
      this.log(`请求 ${endpoint} 失败：${err.message}（${Date.now() - t0}ms）`, 'error');
      throw err;
    }
    const code = res?.code;
    const level = code === 0 ? 'info' : 'warn';
    this.log(`请求 ${endpoint} → code=${code}${code === 0 ? '' : ` ${res?.message || ''}`}（${Date.now() - t0}ms）`, level);
    if (signed && (code === -352 || code === -403)) {
      this.log(`签名被拒（code=${code}），刷新指纹重试`, 'warn');
      const fresh = await this.guard.get(this.loginState, true);
      const retry = signParams({ ...params, ...this.guard.fingerprint() }, fresh.mixinKey[0], fresh.mixinKey[1]);
      const retryRes = await net.getJson(`https://api.bilibili.com${endpoint}?${retry}`, { headers: this.headers(source, fresh) });
      const rc = retryRes?.code;
      if (rc === -412 || rc === -403) this.riskSignal++;
      return retryRes;
    }
    if (code === -412 || code === -403) this.riskSignal++;
    return res;
  }

  /** 请求头：Cookie + 空间页 Referer，并补齐浏览器会带的头，降低被风控概率。 */
  headers(source, ctx) {
    const jar = (ctx && ctx.jar) || this.loginState.cookies || {};
    return {
      Cookie: net.cookieHeader(jar),
      Referer: `https://space.bilibili.com/${source.platformKey}/`,
      Origin: 'https://space.bilibili.com',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    };
  }

  async readUser(source, node) {
    const name = String(node.name || source.name || '').trim();
    const face = normalizeUrl(node.face || '');
    const user = { name, avatarUrl: face, sign: String(node.sign || '') };
    if (face) user.avatar = await this.cacheAvatar(source, face);
    return user;
  }

  /** 内容列表入口：按订阅勾选的形式分发。maxPages 由调用方区分「回溯」与「增量」。 */
  async fetchItems(source, rangeDays, known, options = {}) {
    const { maxItems = 0, maxPages = 12, backfill = false, onBatch } = options;
    this.emptyStreak = 0;
    this.riskSignal = 0;
    this.snapshotBudget = 6;
    const kinds = new Set(source.contentTypes?.length ? source.contentTypes : this.contentTypes);
    const wantsDynamic = [...kinds].some((k) => k !== '视频');
    this.log(`B站采集开始 ${source.name || source.platformKey}（mid=${source.platformKey}）范围 ${rangeDays} 天，${backfill ? '补抓' : '增量'}，形式 ${[...kinds].join('/')}，已入库 ${known.size}，最多 ${maxPages} 页`);
    const groups = [];
    if (kinds.has('视频')) groups.push(this.videoPages(source, rangeDays, known, maxItems, maxPages, backfill, onBatch));
    if (wantsDynamic) groups.push(this.dynamicPages(source, rangeDays, known, maxItems, kinds, maxPages, backfill, onBatch));
    const lists = await Promise.all(groups);
    const flat = lists.flat().sort((a, b) => b.publishedAt - a.publishedAt);
    this.log(`B站采集结束：拿到 ${flat.length} 条${flat.length ? '' : '（0 条时看上面的分页行：是接口没数据还是被范围滤掉）'}`);
    return flat;
  }

  /**
   * B站常出现 code=0 但列表为空（实测抖动，可能持续数十秒），遇到空页先重试再放弃。
   * isEmpty(res) 由调用方给出，因为两个接口的「空」长得不一样。
   */
  async fetchWithRetry(endpoint, params, source, isEmpty) {
    const attempts = this.def.emptyRetries || 3;
    for (let i = 0; i < attempts; i++) {
      const res = await this.api(endpoint, params(i), source, true);
      if (!isEmpty(res)) return res;
      this.emptyStreak++;
      if (i < attempts - 1) {
        this.log(`${endpoint} 空页（第 ${i + 1}/${attempts} 次），等 ${4 * (i + 1)}s 重试`, 'warn');
        await net.sleep(4000 * (i + 1)); // 抖动会自行恢复，多等一会儿再试
      }
    }
    this.log(`${endpoint} 连续 ${attempts} 次空页，放弃本页`, 'warn');
    return { code: 0, data: {}, giveUp: true };
  }

  /**
   * 投稿列表的空页判定。
   * 有 data.page（说明请求本身是成功的）却拿不到 vlist，就认为这一页是抖动，必须重试。
   * 但 count=0 表示真的没有投稿，不再重试，避免没作品的 UP 被误判。
   */
  isVideoPageEmpty(res) {
    if (!res || res.code !== 0) return false;
    if (!res.data?.page) return true;
    // count=0 表示这个 UP 确实没有投稿，不是抖动，不该重试
    if (Number(res.data.page.count ?? 0) === 0) return false;
    return (res.data?.list?.vlist || []).length === 0;
  }

  /** 动态列表的空页判定：items 为空就是抖动（除非整个 data 都没有）。 */
  isDynamicPageEmpty(res) {
    if (!res || res.code !== 0) return false;
    return (res.data?.items || []).length === 0;
  }

  /**
   * 抓完给调用方的诊断：只有真正出现 -412 / -403 风控错误码才算限流。
   * 空列表只代表「这个 UP 没作品 / 近期没发」，不是故障，绝不能报风控。
   */
  diagnose() {
    if (this.riskSignal > 0) {
      this.log(`本轮出现 ${this.riskSignal} 次风控错误码（-412/-403），判定被限流`, 'warn');
      return { message: 'B站接口返回风控错误（-412/-403），多半被限流了。登录后能明显缓解，也可以在设置里调大检查间隔。' };
    }
    return null;
  }

  /** 视频列表：pn 翻页，连续命中已入库条目就停（增量优化；补抓时禁用，要翻到更早）。 */
  async videoPages(source, rangeDays, known, maxItems, maxPages = 12, backfill = false, onBatch) {
    const pageSize = this.def.pageSize || 30;
    const out = [];
    for (let pn = 1; pn <= maxPages; pn++) {
      // platform=web 是必需的：不加会直接 -1「请求失败」（实测）
      const res = await this.fetchWithRetry('/x/space/wbi/arc/search',
        () => ({ mid: source.platformKey, ps: pageSize, pn, order: 'pubdate', index: 0, platform: 'web' }),
        source, (r) => this.isVideoPageEmpty(r));
      const list = res?.data?.list?.vlist || [];
      const total = Number(res?.data?.page?.count ?? 0);
      if (!list.length) { this.log(`视频页 pn=${pn} 空，停止翻页`, 'warn'); break; }
      if (total === 0) { this.log('该 UP 主没有投稿（count=0）'); return out; }
      let knownRun = 0;
      let staged = 0;  // 本页入库数
      let dropped = 0; // 本页被范围滤掉数
      const pagePosts = []; // 本页新入库的（供逐页批次提交）
      for (const raw of list) {
        const post = await this.stage(source, this.videoMapper(source, raw), rangeDays);
        if (!post) { dropped++; continue; }
        if (known.has(post.id)) {
          if (!backfill && ++knownRun >= 6) {
            this.log(`视频页 pn=${pn}：连续命中已入库 6 条，增量到此为止（累计 ${out.length}）`);
            return out;
          }
          continue;
        }
        knownRun = 0;
        out.push(post);
        pagePosts.push(post);
        staged++;
        if (maxItems && out.length >= maxItems) { onBatch?.(pagePosts); return out; }
      }
      // 这页抓完先落库：中途断掉也不至于白翻
      onBatch?.(pagePosts);
      this.log(`视频页 pn=${pn}：返回 ${list.length} 条，入库 ${staged}，范围外 ${dropped}，累计 ${out.length}/${total}`);
      // 列表按时间倒序：整页都在范围之外，更早的页没有翻的意义
      if (!staged && dropped) { this.log(`整页都早于回看范围（${rangeDays} 天），停止翻页`); return out; }
      if (list.length < pageSize) break;
    }
    return out;
  }

  /** 动态 / 图文 / 专栏：offset 翻页，逐条 detail 复核删除。 */
  async dynamicPages(source, rangeDays, known, maxItems, kinds, maxPages = 12, backfill = false, onBatch) {
    let offset = '';
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.fetchWithRetry('/x/polymer/web-dynamic/v1/feed/space',
        () => ({ host_mid: source.platformKey, offset, timezone_offset: -480, features: 'itemOpusStyle', platform: 'web' }),
        source, (r) => this.isDynamicPageEmpty(r));
      const items = res?.data?.items || [];
      if (!items.length) { this.log(`动态页 ${page} 空，停止翻页`, 'warn'); break; }
      let staged = 0;
      let dropped = 0;
      const pagePosts = [];
      for (const item of items) {
        const post = await this.stageDynamic(source, item, rangeDays, kinds);
        if (!post) { dropped++; continue; }
        if (known.has(post.id)) continue;
        // 纯文字动态没有封面图：截一张动态页面的图当封面快照
        if (!post.cover) await this.snapshotCover(post);
        out.push(post);
        pagePosts.push(post);
        staged++;
        if (maxItems && out.length >= maxItems) { onBatch?.(pagePosts); return out; }
      }
      // 这页抓完先落库
      onBatch?.(pagePosts);
      this.log(`动态页 ${page}：返回 ${items.length} 条，入库 ${staged}，未入 ${dropped}，累计 ${out.length}`);
      // 动态流同样按时间倒序：整页都进不了库（超出范围居多），早停
      if (!staged && dropped && backfill) { this.log(`整页都进不了库（多半早于 ${rangeDays} 天），停止翻页`); break; }
      offset = res?.data?.offset || '';
      if (!offset || !res?.data?.has_more) break;
    }
    return out;
  }

  /** 动态先按时间与类型过滤，再走 detail 接口复核是否已被删除。 */
  async stageDynamic(source, item, rangeDays, kinds) {
    const idStr = String(item.id_str || '');
    if (!idStr) return null;
    const kind = this.dynamicKind(item);
    if (kinds && !kinds.has(kind)) return null;
    const publishedAt = Number(item.modules?.module_author?.pub_ts || 0) * 1000;
    if (publishedAt && isFinite(rangeDays) && publishedAt < Date.now() - rangeDays * 86400000) return null;
    const detail = await net.getJson(
      `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${idStr}&timezone_offset=-480`,
      { headers: this.headers(source) });
    if (detail?.code === -404) return null; // 已删除：不入库，历史里保留旧记录
    const node = detail?.code === 0 ? detail.data?.item : item;
    return this.stage(source, this.dynamicMapper(source, node || item, kind), rangeDays);
  }

  dynamicKind(item) {
    const major = item.modules?.module_dynamic?.major;
    if (major?.article) return '专栏文章';
    if (major?.draw || major?.opus) return '图文';
    // 带视频的动态（major.archive）与纯文字动态统一归「动态」：
    // 它们的链接都是 t.bilibili.com/<动态id>，和投稿视频（BV 号、video 页）是两种东西，
    // 以前把带视频的动态标成「视频」会让两者混淆。
    return '动态';
  }

  /**
   * 无图动态的封面快照：用隐藏窗口打开动态页截一张图存到本地。
   * 每轮同步限制张数（见 fetchItems 的 snapshotBudget），避免纯文字动态多时拖慢同步；
   * 截不到就保持无封面，不影响入库。
   */
  async snapshotCover(post) {
    if (this.snapshotBudget <= 0 || !post.link) return;
    if (!this.ctx.browser || typeof this.ctx.browser.captureScreenshot !== 'function') return;
    this.snapshotBudget--;
    const png = await this.ctx.browser.captureScreenshot(post.link).catch(() => null);
    if (!png || png.length < 2000) return;
    try {
      const rel = `media/${this.id}/shot-${String(post.platformItemId || '').replace(/[^\w.-]/g, '_')}.png`;
      require('fs').writeFileSync(this.ctx.store.file(rel), png);
      post.cover = rel;
    } catch { /* 写不进就算了 */ }
  }

  /**
   * 动态字段映射。
   * 注意：feed 接口默认返回 opus 新版结构（major.opus），而 detail 接口返回的是原始结构
   * （图文在 major.draw.items、视频在 major.archive），所以两套都要兜住。
   */
  dynamicMapper(source, item, kind) {
    const dynamic = item.modules?.module_dynamic || {};
    const major = dynamic.major || {};
    const opus = major.opus || {};
    const draw = major.draw || {};
    const archive = major.archive || {};
    const article = major.article || {};
    const pics = opus.pics || draw.items || [];
    const title = opus.title || drawTitle(draw) || dynamic.desc?.text || archive.title || article.title || '';
    const body = opus.summary?.text || dynamic.desc?.text || archive.desc || article.desc || article.summary || '';
    const coverUrl = pics[0]?.url || archive.cover || article.covers?.[0] || '';
    return {
      platformItemId: String(item.id_str || ''),
      kind,
      title: String(title).slice(0, 120),
      body: String(body).slice(0, 2000),
      link: `https://t.bilibili.com/${item.id_str}`,
      coverUrl: normalizeUrl(coverUrl),
      publishedAt: Number(item.modules?.module_author?.pub_ts || 0) * 1000,
      author: source.name,
    };
  }

  /** 视频字段映射。 */
  videoMapper(source, raw) {
    return {
      platformItemId: raw.bvid,
      kind: '视频',
      title: raw.title,
      body: raw.description || '',
      link: `https://www.bilibili.com/video/${raw.bvid}`,
      coverUrl: normalizeUrl(raw.pic),
      publishedAt: toMillis(raw.created || raw.pubdate),
      author: source.name,
    };
  }

  /** 直播状态：先拿 room_id（缓存），再查 live_status。 */
  async checkLive(source) {
    const roomId = await this.roomId(source);
    if (!roomId) return null;
    const liveUrl = this.def.urls?.live || 'https://api.live.bilibili.com/room/v1/Room/get_info';
    const res = await net.getJson(`${liveUrl}?room_id=${roomId}`, { headers: this.headers(source) });
    const data = res?.data;
    if (!data) return null;
    return {
      live: data.live_status === 1,
      title: data.title || '',
      coverUrl: data.cover || data.user_cover || data.keyframe || '',
      link: `https://live.bilibili.com/${roomId}`,
    };
  }

  /** room_id 只需要取一次，之后缓存复用。 */
  async roomId(source) {
    if (this.roomIds.has(source.platformKey)) return this.roomIds.get(source.platformKey);
    const info = await this.api('/x/space/wbi/acc/info', { mid: source.platformKey, platform: 'web' }, source, true);
    const roomId = info?.data?.live_room?.roomid || 0;
    this.roomIds.set(source.platformKey, roomId);
    return roomId;
  }

  /** 登录态校验 + 取用户展示名。 */
  async verifyLogin() {
    const ctx = await this.guard.get(this.loginState, true).catch(() => null);
    const res = await net.getJson('https://api.bilibili.com/x/web-interface/nav',
      { headers: { Cookie: net.cookieHeader(this.loginState.cookies) } });
    const data = res?.data || {};
    this.log(`登录校验：${data.isLogin ? `已登录（${data.uname || ''}${ctx ? '' : '，WBI 未就绪'}）` : '未登录或已失效'}`, data.isLogin ? 'info' : 'warn');
    if (data.isLogin) {
      await this.cacheAvatar({ platformKey: String(data.mid || 'me'), id: 'me' }, normalizeUrl(data.face || '')).catch(() => null);
      return { ok: true, message: '', name: data.uname, avatarUrl: data.face, mid: data.mid, wbi: !!ctx };
    }
    return { ok: false, message: '未登录或登录态已失效，请点「登录」扫码/短信登录 B站' };
  }
}

/** //i0.hdslb.com/... 这类协议相对地址补成 https。 */
function normalizeUrl(url) {
  const text = String(url || '');
  if (text.startsWith('//')) return 'https:' + text;
  return text;
}

/** 图文的标题在 draw 的 nodes 文本节点里，取第一段有内容的文字。 */
function drawTitle(draw) {
  const nodes = draw?.nodes || [];
  for (const node of nodes) {
    const text = node?.text || node?.data?.text;
    if (text) return String(text);
    if (Array.isArray(node?.nodes) && node.nodes[0]?.text) return String(node.nodes[0].text);
  }
  return '';
}

module.exports = { BiliPlatform };
