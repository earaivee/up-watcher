'use strict';
/**
 * 内置平台定义。
 * 一律使用「统一配置格式」——内置平台和用户自定义平台在这里没有区别，
 * 用户改过之后会被持久化，重启依然生效（见 registry.js）。
 */

const DEFINITIONS_VERSION = 3;

const BILIBILI = {
  id: 'bilibili',
  name: 'B站',
  color: '#00a1d6',
  builtin: true,
  gridRatio: '16:9', // 图墙封面默认宽高比（横屏视频）
  contentTypes: ['视频', '动态', '图文', '专栏文章'],
  historyMaxDays: 3650,
  supportsRange: true,
  pageSize: 30,
  maxPages: 12,
  order: 'desc',
  emptyRetries: 3,
  driver: 'http',
  identifyRules: [
    { pattern: 'space\\.bilibili\\.com/(\\d+)', hint: 'UID' },
    { pattern: '^\\s*(\\d{3,})\\s*$', hint: 'UID' },
  ],
  urls: {
    list: 'https://api.bilibili.com/x/space/wbi/arc/search',
    profile: 'https://api.bilibili.com/x/space/wbi/acc/info',
    detail: 'https://api.bilibili.com/x/web-interface/view',
    live: 'https://api.live.bilibili.com/room/v1/Room/get_info',
  },
  mapper: {
    list: 'data.list.vlist',
    hasMore: 'data.page.count',
    item: { id: 'bvid', title: 'title', body: 'description', cover: 'pic', time: 'created', kind: 'type' },
    profile: { name: 'name', face: 'face', sign: 'sign' },
  },
  login: {
    entry: 'https://passport.bilibili.com/login',
    cookieUrl: 'https://www.bilibili.com',
    verifyUrl: 'https://api.bilibili.com/x/web-interface/nav',
    verifyPath: 'data.isLogin',
    userPath: 'data.uname',
    cookieNames: ['SESSDATA', 'DedeUserID'],
    hint: '登录态已失效，请重新登录 B站（登录后能明显缓解风控限流）',
    gate: 'soft',
  },
  fallback: { mode: 'page' },
};

const DOUYIN = {
  id: 'douyin',
  name: '抖音',
  color: '#fe2c55',
  builtin: true,
  contentTypes: ['视频', '图文'],
  historyMaxDays: 1095,
  supportsRange: true,
  pageSize: 18,
  maxPages: 6,
  order: 'desc',
  scrollTimes: 2,
  scrollDelay: 1800,
  settleMs: 1500,
  backfillScrollTimes: 12, // 老布局补抓时往下翻页的次数（新布局走 DOM 网格，不用这个）
  gridRatio: '9:16', // 图墙封面默认宽高比（竖屏视频）
  driver: 'browser',
  identifyRules: [
    { pattern: 'sec_uid=([\\w-]+)', hint: 'sec_uid' },
    { pattern: 'douyin\\.com/user/([\\w-]{10,})', hint: '主页地址' },
  ],
  capture: {
    profile: '/aweme/v1/web/user/profile/other/',
    list: '/aweme/v1/web/aweme/post/',
    live: '/webcast/room/web/enter/',
  },
  urls: {},
  browser: {
    pageUrl: 'https://www.douyin.com/user/{sourceKey}',
    liveUrl: 'https://live.douyin.com/{roomKey}',
    followingUrl: 'https://www.douyin.com/user/self?showTab=following',
    itemSelectors: { item: 'li[data-e2e="user-post-item"]', link: 'a@href', title: 'img@alt', cover: 'img@src' },
  },
  login: {
    entry: 'https://www.douyin.com/',
    cookieUrl: 'https://www.douyin.com',
    // 抖音没有稳定的公开登录态校验接口，靠「登录后才出现的凭证 cookie」判断。
    // 注意：sessionid / sessionid_ss / sid_tt 未登录访客也会下发，靠它们判断会
    // 误报「已登录」——症状就是资料接口能返回、作品列表接口一次都不发。
    // 真正登录后才有的标志是 sid_guard（登录保护）和 uid_tt / uid_tt_ss（用户 id）。
    cookieNames: ['sid_guard', 'uid_tt', 'uid_tt_ss'],
    hint: '抖音要求登录或触发了验证，请在登录窗口里完成后再抓取',
    gate: 'soft',
  },
  fallback: { mode: 'page' },
};

/** 用户新建自定义平台时的起点模板。 */
const CUSTOM_TEMPLATE = {
  id: '',
  name: '',
  color: '#6b7280',
  builtin: false,
  contentTypes: ['视频'],
  historyMaxDays: 365,
  supportsRange: true,
  pageSize: 20,
  maxPages: 6,
  order: 'desc',
  driver: 'generic',
  identifyRules: [{ pattern: 'example\\.com/user/(\\d+)', hint: '用户 id' }],
  urls: {
    list: 'https://example.com/api/posts?uid={sourceKey}&page={page}',
    profile: 'https://example.com/api/user?uid={sourceKey}',
  },
  mapper: {
    list: 'data.list',
    hasMore: 'data.has_more',
    item: { id: 'id', title: 'title', body: 'desc', link: 'link', cover: 'cover', time: 'pubdate', kind: 'type' },
    profile: { name: 'name', face: 'face', sign: 'sign' },
  },
  login: {
    entry: 'https://example.com/login',
    cookieUrl: 'https://example.com',
    verifyUrl: 'https://example.com/api/me',
    verifyPath: 'data.isLogin',
    cookieNames: ['sid'],
    hint: '登录态已失效，请重新登录',
    gate: 'soft',
  },
  browser: {
    pageUrl: 'https://example.com/user/{sourceKey}',
    scrollTimes: 0,
    itemSelectors: { item: 'div.post', title: 'h3', link: 'a@href', cover: 'img@src', time: 'time@datetime' },
  },
  fallback: { mode: 'page' },
};

/** 内置平台定义（深拷贝，避免调用方改到常量）。 */
function builtinDefinitions() {
  return JSON.parse(JSON.stringify([BILIBILI, DOUYIN]));
}

module.exports = { builtinDefinitions, CUSTOM_TEMPLATE, DEFINITIONS_VERSION };
