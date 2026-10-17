'use strict';
/**
 * 抖音驱动。
 * 接口带 a_bogus / X-Bogus 签名与 uifid 校验，纯 HTTP 必被 ArgusSecurityPlugin 拦，
 * 所以这里开隐藏窗口让页面自己的 JS 去签名，再用 CDP 截 /aweme/v1/web/aweme/post/ 的响应。
 *
 * 实测要点：
 *  - 滚动不要贪多：滚 2 次稳定拿 18 条，滚 10 次只剩 5 条（缓冲被回收）；
 *  - 不登录经常拿不到最新作品，被要求滑块验证时作品列表为空 → 如实提示去登录；
 *  - 内容形式只有 视频 / 图文（aweme_type === 68 或带 images）。
 */

const { Platform, toMillis } = require('./base');
const net = require('../core/net');

const KINDS = ['视频', '图文'];
const POST_API = '/aweme/v1/web/aweme/post/';
const SHARE_HOST = /v\.douyin\.com|iesdouyin\.com/i;

class DouyinPlatform extends Platform {
  constructor(definition, context) {
    super(definition, context);
    this.captured = { posts: [], profile: null, followings: [], blocked: false };
  }

  get contentTypes() { return KINDS; }
  get historyMaxDays() { return 1095; } // 抖音通常只能回溯到约三年
  get session() { return this.ctx.browser; }

  /** 识别 sec_uid / 主页地址 / 分享短链。 */
  async identify(input) {
    const text = String(input || '').trim();
    const secUid = /sec_uid=([\w-]+)/i.exec(text);
    if (secUid) return { key: secUid[1], hint: 'sec_uid' };
    const userPath = /douyin\.com\/user\/([\w-]{10,})/i.exec(text);
    if (userPath) return { key: userPath[1], hint: '主页地址' };
    if (SHARE_HOST.test(text)) return this.resolveShortLink(text);
    if (/^MS4wLjAB[\w-]{20,}$/.test(text)) return { key: text, hint: 'sec_uid' };
    return null;
  }

  /** 分享短链先跟着重定向走到主页，再截 sec_uid。 */
  async resolveShortLink(text) {
    const url = /https?:\/\/\S+/.exec(text)?.[0] || text;
    const res = await net.request(url, { headers: { 'User-Agent': net.UA } });
    const finalUrl = res?.url || '';
    const fromUrl = /user\/([\w-]{10,})/.exec(finalUrl)?.[1];
    if (fromUrl) return { key: fromUrl, hint: '短链解析' };
    if (res && res.ok) {
      const body = await res.text().catch(() => '');
      const fromBody = /sec_uid=([\w-]{20,})/i.exec(body)?.[1] || /user\/([\w-]{20,})/.exec(body)?.[1];
      if (fromBody) return { key: fromBody, hint: '短链解析' };
    }
    return null;
  }

  /** 主页地址：能直接用 sec_uid，否则靠页面 RENDER_DATA 反查。 */
  pageUrl(source) {
    return `https://www.douyin.com/user/${source.platformKey}`;
  }

  /**
   * 抓取一个订阅源：资料与作品列表在**一次导航**里全截完。
   * 不按基类那样「fetchProfile 导航一次、fetchItems 再导航一次」——
   * 同一主页连续导航两次，第二次页面常直接用内存数据渲染、不再发作品接口的 XHR，
   * CDP 就静默截到 0 条（实测单次导航稳定截到 /aweme/post/ 响应）。
   */
  async collect(source, options = {}) {
    const { rangeDays, known = new Set(), maxItems = 0 } = options;
    this.captured = { posts: [], profile: null, followings: [], blocked: false };
    this.rangeNotice = null;

    // 一次导航同时截：用户资料接口 + 作品列表接口
    this.session.capture(this.def.capture?.profile || '/aweme/v1/web/user/profile/other/', (text) => {
      const json = safeJson(text);
      const user = json?.user || json?.user_info || json?.data?.user;
      if (user) this.captured.profile = user;
    });
    this.session.capture(POST_API, (text) => {
      const json = safeJson(text);
      if (json && Array.isArray(json.aweme_list)) this.captured.posts.push(...json.aweme_list);
    });

    await this.session.goto(this.pageUrl(source));
    await this.ensureLoggedInOrWarn();
    // 补抓要尽量翻全：滚动次数放大，加载出更早的作品
    const scrollTimes = options.backfill
      ? (this.def.backfillScrollTimes || 12)
      : (this.def.scrollTimes || 2);
    await this.session.scroll(scrollTimes, this.def.scrollDelay || 1800);
    await this.persistCookies();

    // 资料：接口没截到就从页面内嵌 RENDER_DATA 兜底
    let user = this.captured.profile;
    if (!user) user = await this.readUserFromHtml();
    const profile = user ? await this.readUser(source, user) : null;

    const posts = dedupe(this.captured.posts)
      .sort((a, b) => toMillis(b.create_time) - toMillis(a.create_time));
    const blocked = this.diagnose();
    if (blocked && !posts.length) return { ok: false, needLogin: true, message: blocked.message };

    const items = [];
    for (const aweme of posts) {
      const post = await this.stage(source, this.mapItem(source, aweme), rangeDays);
      if (post) items.push(post);
      if (maxItems && items.length >= maxItems) break;
    }
    // 直播状态走子类 checkLive（当前为按需检测、返回 null；将来实现后这里自动生效）
    const live = await this.checkLive(source).catch(() => null);
    // 截到了作品却全被回看范围滤掉：如实说明，别让用户对着 0 条猜「是不是坏了」。
    // 实测：博主最新作品在 15 天前时，默认「近 15 天」回溯会静默抓到 0 条。
    this.rangeNotice = posts.length && !items.length && isFinite(rangeDays)
      ? `抓到 ${posts.length} 条作品，但都早于回看范围（近 ${rangeDays} 天）；在「订阅设置」里调大回看范围后点「补抓历史」`
      : null;
    return {
      ok: true,
      profile,
      items,
      live,
      notice: !items.length ? this.rangeNotice : null,
      fetchedAt: Date.now(),
    };
  }

  /** 页面内嵌 RENDER_DATA（URL 编码的 JSON）里通常带用户资料。 */
  async readUserFromHtml() {
    const raw = await this.session.eval(
      `(() => { const el = document.getElementById('RENDER_DATA'); return el ? decodeURIComponent(el.textContent) : null; })()`);
    const json = safeJson(raw);
    return json?.app?.user?.userInfo?.user || null;
  }

  /** 昵称 + 头像本地化 + 个性签名。头像字段接口是 snake_case、页面数据是 camelCase，两边都认。 */
  async readUser(source, user) {
    const avatarList = user.avatar_larger?.url_list || user.avatarLarger?.url_list
      || user.avatar_168x168?.url_list || user.avatar_168x168?.urlList
      || user.avatar_medium?.url_list || user.avatarMedium?.url_list
      || user.avatar_thumb?.url_list || user.avatarThumb?.url_list || [];
    const avatarUrl = avatarList[0] || '';
    const profile = {
      name: String(user.nickname || source.name || '').trim(),
      avatarUrl,
      sign: String(user.signature || ''),
      secUid: user.sec_uid || source.platformKey,
    };
    if (avatarUrl) profile.avatar = await this.cacheAvatar(source, avatarUrl);
    return profile;
  }

  /** 把页面 Cookie 落盘，登录态就能跟着数据目录走（切换帐号后会自动更新）。 */
  async persistCookies() {
    if (!this.ctx.saveSession) return;
    const jar = await require('../core/browser').BrowserSession.readCookies('https://www.douyin.com');
    if (Object.keys(jar).length) await this.ctx.saveSession(jar);
  }

  /** 页面里出现登录/验证提示就标记，让调用方如实提示而不是假装抓到 0 条。 */
  async ensureLoggedInOrWarn() {
    const text = await this.session.eval(
      `(() => document.body ? document.body.innerText.slice(0, 4000) : '')()`) || '';
    if (/登录后查看|请先登录|验证|滑块|操作频繁/.test(text)) this.captured.blocked = true;
  }

  /**
   * 从「我的关注」里取人。
   *
   * 实测结论（2026-10，真机研究）：
   *  - /user/self?showTab=following 的 showTab 参数已失效，页面只停在「作品」tab，
   *    关注列表接口 /aweme/v1/web/user/following/list/ 不会自动触发；
   *  - self 页不再重定向到 /user/<sec_uid>，RENDER_DATA 也拿不到 sec_uid，
   *    所以老版「先拿 sec_uid 再跳转」的整条链路已经不成立；
   *  - 现在的正确入口是：在个人主页点「关注 N」统计数字，弹出关注列表面板，
   *    面板才会发 /user/following/list/ 请求 —— 这里用 CDP 截它的 JSON 响应。
   *
   * 流程：进 self 页 → 点「关注」统计 → 等面板接口 → 滚动面板加载更多 → DOM 兜底。
   */
  async fetchFollowings() {
    if (!this.isLoggedIn) throw new Error('请先登录抖音，再点「从我的关注里选」');
    this.session.clearRules();
    this.captured.followings = [];
    // 截关注列表接口：URL 含 following 的 JSON 响应，宽松提取「像用户的数组」
    this.session.capture('following', (text) => {
      const list = findFollowingList(safeJson(text));
      if (list.length) this.captured.followings.push(...list);
    });
    // 打开个人主页（showTab 参数即使失效也无妨，面板靠点击打开）
    const base = this.def.browser?.followingUrl || 'https://www.douyin.com/user/self?showTab=following';
    await this.session.goto(base);
    await this.persistCookies();
    await net.sleep(this.def?.settleMs || 2000);
    // 点「关注 N」统计，打开关注列表面板（列表接口由面板触发）
    const clickResult = await this.clickFollowStat();
    if (clickResult === 'not-found') {
      const bodyText = await this.pageText();
      if (this.looksBlocked(bodyText)) {
        throw new Error('抖音要求登录或触发了验证，请在设置里点「登录」完成验证后重试');
      }
      throw new Error('没找到「关注」入口，页面结构可能变了；也可以直接粘贴对方主页地址订阅');
    }
    await net.sleep(2500); // 等面板首屏接口返回
    // 面板是内部滚动容器，窗口滚动 + 容器滚动都做，触发翻页
    await this.scrollPanel(this.def.followingScrollTimes || 4, this.def.followingScrollDelay || 1500);
    await net.sleep(1000); // 等最后一轮响应体读完
    // 优先用接口数据
    if (this.captured.followings.length) {
      const out = this.captured.followings.map((u) => ({
        key: u.sec_uid || u.uid || '',
        name: u.nickname || u.unique_id || u.name || '',
        avatarUrl: (u.avatar_larger?.url_list || u.avatar_medium?.url_list || u.avatar_thumb?.url_list || [])[0] || '',
        sign: u.signature || '',
      })).filter((u) => u.key && u.name);
      if (out.length) return out;
    }
    // 兜底：DOM 解析（接口没截到时；排除 /user/self，只认有名字的卡片）
    const rows = await this.session.eval(`(() => {
      const links = [...document.querySelectorAll('a[href*="/user/"]')];
      const seen = new Map();
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        if (href.includes('/user/self')) continue;
        const hit = /\\/user\\/([\\w-]{10,})/.exec(href);
        if (!hit) continue;
        const text = (a.innerText || '').trim().split('\\n')[0];
        if (!text) continue;
        const prev = seen.get(hit[1]);
        if (prev) { if (!prev.avatarUrl) { const img = a.querySelector('img'); if (img) prev.avatarUrl = img.src; } continue; }
        const img = a.querySelector('img') || (a.closest('div') || a.parentElement)?.querySelector('img');
        seen.set(hit[1], { key: hit[1], name: text, avatarUrl: img ? img.src : '', sign: '' });
      }
      return [...seen.values()];
    })()`);
    if (!rows || !rows.length) {
      const bodyText = await this.pageText();
      if (this.looksBlocked(bodyText)) {
        throw new Error('抖音要求登录或触发了验证，请在设置里点「登录」完成验证后重试');
      }
      throw new Error('没读到关注列表，可能是还没登录、被要求验证，或页面结构变了；也可以直接粘贴对方主页地址订阅');
    }
    return rows;
  }

  /** 点「关注 N」统计数字打开关注面板。返回点击结果描述。 */
  async clickFollowStat() {
    return await this.session.eval(`(() => {
      const vis = (n) => n.offsetParent !== null;
      // ① 「关注 N」写在一起的元素
      let cands = [...document.querySelectorAll('a,span,div,p')]
        .filter((n) => vis(n) && /^关注\\s*\\d+$/.test((n.innerText || '').replace(/\\s+/g, '')));
      // ② 「关注」单独元素，同容器里还有「粉丝」（个人主页统计行）
      if (!cands.length) {
        cands = [...document.querySelectorAll('span,div,a')].filter((n) => {
          if (!vis(n) || (n.innerText || '').trim() !== '关注') return false;
          const box = n.closest('div');
          return box && /粉丝|获赞/.test(box.innerText || '');
        });
      }
      if (!cands.length) return 'not-found';
      const target = cands[0].closest('a') || cands[0];
      target.click();
      return 'clicked:' + target.tagName;
    })()`);
  }

  /** 滚动关注面板：窗口滚动 + 面板内部滚动容器都滚，触发翻页接口。 */
  async scrollPanel(times = 4, delayMs = 1500) {
    for (let i = 0; i < times; i++) {
      await this.session.eval(`(() => {
        window.scrollTo(0, document.body.scrollHeight);
        // 找弹层里的滚动容器（面板通常自带 overflow 容器）
        const boxes = [...document.querySelectorAll('div')]
          .filter((d) => d.scrollHeight > d.clientHeight + 50 && d.clientHeight > 200 && d.offsetParent !== null)
          .slice(0, 5);
        for (const b of boxes) b.scrollTop = b.scrollHeight;
        return boxes.length;
      })()`);
      await net.sleep(delayMs);
    }
  }

  /** 当前页面可见文本（读不到返回空串）。 */
  async pageText() {
    return (await this.session.eval(
      `(() => document.body ? document.body.innerText.slice(0, 3000) : '')()`)) || '';
  }

  /** 文本里出现登录/验证提示就算被拦。 */
  looksBlocked(bodyText) {
    return /登录后查看|请先登录|验证|滑块|操作频繁|请完成验证/.test(bodyText || '');
  }

  /** 作品字段映射：图文判定 aweme_type === 68 或带 images。 */
  mapItem(source, aweme) {
    const id = String(aweme.aweme_id || '');
    const images = aweme.images || [];
    const isImage = aweme.aweme_type === 68 || images.length > 0;
    const cover = images[0]?.url_list?.[0]
      || aweme.video?.cover?.url_list?.[0]
      || aweme.video?.origin_cover?.url_list?.[0] || '';
    return {
      platformItemId: id,
      kind: isImage ? '图文' : '视频',
      title: String(aweme.desc || '').trim() || (isImage ? '图文作品' : '视频作品'),
      body: String(aweme.desc || ''),
      link: `https://www.douyin.com/video/${id}`,
      coverUrl: cover,
      publishedAt: toMillis(aweme.create_time),
      author: source.name,
    };
  }

  /** 直播状态：发帖列表为空时给出一条明确说明，不伪造内容。 */
  async checkLive(source) {
    if (this.captured.blocked) return null;
    return null; // 直播状态由独立窗口按需检测，避免干扰作品抓取
  }

  /** 抓完给调用方的诊断信息。 */
  diagnose() {
    // 页面常驻「登录」入口、登录弹层文本也常含「验证」字样，而未登录时作品接口
    // 照样返回（实测）。所以只有「一条作品响应都没截到」且页面有提示时才算被拦，
    // 否则会把「抓到了数据」误报成「要求登录」。
    if (this.captured.blocked && !this.captured.posts.length) {
      return { needLogin: true, message: '抖音要求登录或触发了验证，请点「登录」在弹出窗口里完成验证后重试' };
    }
    return null;
  }
}

/** 宽松解析 JSON，失败返回 null。 */
function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** 按作品 id 去重（滚动会重复触发同一页响应）。 */
function dedupe(list) {
  const seen = new Map();
  for (const item of list) if (item?.aweme_id) seen.set(item.aweme_id, item);
  return [...seen.values()];
}

/**
 * 宽松地在 JSON 里找「像关注列表」的数组：先试常见字段，
 * 再递归扫一遍——元素带 sec_uid/uid + nickname 才算数，
 * 接口字段调整时也不至于整条链路失效。
 */
function findFollowingList(json) {
  if (!json || typeof json !== 'object') return [];
  const looksUser = (u) => u && typeof u === 'object'
    && (u.sec_uid || u.uid) && (u.nickname || u.unique_id || u.name);
  const common = json.followings || json.data?.followings || json.follow_list
    || json.data?.list || json.user_list || json.data?.user_list;
  if (Array.isArray(common) && common.some(looksUser)) return common.filter(looksUser);
  const found = [];
  const walk = (node, depth) => {
    if (depth > 4 || found.length) return;
    if (Array.isArray(node)) {
      if (node.some(looksUser)) { found.push(...node.filter(looksUser)); return; }
      for (const v of node) walk(v, depth + 1);
      return;
    }
    if (node && typeof node === 'object') for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(json, 0);
  return found;
}

module.exports = { DouyinPlatform, KINDS };
