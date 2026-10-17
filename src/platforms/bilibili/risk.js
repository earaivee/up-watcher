'use strict';
/**
 * B站接口风控相关：WBI 签名、buvid 指纹 cookie、dm_img_* 参数。
 * 实测结论（需求文档第 4 节）：
 *  - 参数不全或没签名 → -352；-352 可以刷新指纹后重试自愈；
 *  - -412 是 IP 级限流，只能等冷却（填 SESSDATA 明显缓解）；
 *  - 必须带 buvid3 / buvid4 与一组 dm_img_* 参数，否则同样 -352。
 */

const net = require('../../core/net');

const MIXIN_KEY_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const WBI_TTL = 30 * 60 * 1000; // 密钥与指纹缓存半小时

/** 把 img_key + sub_key 按固定表重排成 mixinKey。 */
function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

/** 归一化：B站签名要求滤掉 !'()* 这些字符。 */
function filterValue(value) {
  return String(value).replace(/[!'()*]/g, '');
}

/**
 * WBI 签名：参数字典 → 追加 wts，按 key 排序后拼 query + mixinKey 做 md5。
 * 返回已签名并可直接拼到地址后面的 query 串。
 */
function signParams(params, imgKey, subKey) {
  const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(signed).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(filterValue(signed[k]))}`)
    .join('&');
  return `${query}&w_rid=${net.md5(query + mixinKey(imgKey, subKey))}`;
}

/** WBI 密钥：一次请求拿 img_url / sub_url，从文件名里截出 key。 */
async function fetchWbiKeys(jar) {
  const res = await net.getJson('https://api.bilibili.com/x/web-interface/nav', {
    headers: { Cookie: net.cookieHeader(jar) },
  });
  const imgUrl = String(res?.data?.wbi_img?.img_url || '');
  const subUrl = String(res?.data?.wbi_img?.sub_url || '');
  if (!imgUrl || !subUrl) throw new Error('WBI 密钥获取失败');
  return {
    imgKey: imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0],
    subKey: subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0],
    loggedIn: res?.data?.isLogin === true,
    uname: res?.data?.uname || '',
    mid: res?.data?.mid || 0,
  };
}

/** 从 Set-Cookie 里取 buvid3 / buvid4；拿不到就自己去要一份。 */
async function ensureBuvid(jar) {
  if (jar.buvid3 && jar.buvid4) return jar;
  const res = await net.request('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: { Cookie: net.cookieHeader(jar) },
  });
  if (res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.data?.b_3) jar.buvid3 = body.data.b_3;
    if (body?.data?.b_4) jar.buvid4 = body.data.b_4;
  }
  return jar;
}

/**
 * dm_img_* 指纹参数。B站只做格式校验（长度 48 的 base64 串），
 * 给了稳定值就不会因为缺参数被 -352。
 */
function fingerprintParams(sessionId) {
  const seed = String(sessionId || Date.now());
  const b64 = (text, len) => Buffer.from(text).toString('base64').slice(0, len);
  return {
    dm_img_list: '[]',
    dm_img_str: b64(seed + seed, 48),
    dm_cover_img_str: b64(seed, 48),
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
  };
}

/** 带缓存的密钥 / 指纹持有者，-352 时可强制刷新。 */
class RiskGuard {
  constructor() { this.cache = null; }

  /** 取可用上下文（jar / mixinKey / 指纹参数），缓存 30 分钟。 */
  async get(session, force = false) {
    const jar = { ...((session && session.cookies) || {}) };
    if (!force && this.cache && Date.now() - this.cache.at < WBI_TTL) {
      return { ...this.cache, jar: { ...this.cache.jar, ...jar } };
    }
    await ensureBuvid(jar);
    const keys = await fetchWbiKeys(jar);
    this.cache = {
      at: Date.now(), jar, mixinKey: [keys.imgKey, keys.subKey],
      loggedIn: keys.loggedIn, uname: keys.uname, mid: keys.mid,
    };
    return this.cache;
  }

  /** 指纹参数（每次调用现生成，避免与时间强绑定被判定过期）。 */
  fingerprint() { return fingerprintParams(Math.random().toString(36).slice(2)); }
}

module.exports = { RiskGuard, signParams, mixinKey, fingerprintParams, fetchWbiKeys, ensureBuvid };
