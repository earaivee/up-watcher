'use strict';
/**
 * 网络与媒体工具（HTTP 层基于 axios）。
 * 关键点（实测结论）：
 *  - Electron 的 ses.fetch / net.fetch 会拦 Referer，Node 侧的 HTTP 不受影响；
 *  - 接口调用把 Referer 降级成 origin + /，否则跨源带路径会被直接拦掉；
 *  - 图床有防盗链，下载图片必须带完整 Referer；
 *  - B站 -412 是 IP 级限流，全靠按域名限速（paceHost）避免；
 *  - 有的图片地址没有扩展名，落地时按文件头判类型。
 *
 * 对外保持 fetch 风格的响应对象（ok / status / url / headers / text / json /
 * arrayBuffer），调用方（risk.js / douyin.js 等）无感。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 常见站点的接口 Referer：跨源带路径会被拦，所以统一降级为 origin。 */
function originReferer(url) {
  try { return new URL(url).origin + '/'; } catch { return undefined; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (text) => crypto.createHash('md5').update(text).digest('hex');

/* 同一域名的请求排队，保证间隔——B站的 -412 是 IP 级限流，全靠这里避免。 */
const hostGate = new Map();

/** 按域名限速：同域名两次请求至少间隔 minGap 毫秒。 */
async function paceHost(url, minGap = 350) {
  let host = 'unknown';
  try { host = new URL(url).host; } catch { /* 保持默认 */ }
  const slot = hostGate.get(host) || 0;
  const wait = Math.max(0, slot - Date.now());
  hostGate.set(host, Date.now() + wait + minGap);
  if (wait > 0) await sleep(wait);
}

/** axios 响应 → fetch 风格响应对象。最终地址取 Node 层的 responseUrl（axios 本身不暴露重定向后的地址）。 */
function toResponse(res) {
  const buf = Buffer.from(res.data || []);
  const ctype = String(res.headers['content-type'] || '');
  const charset = /charset=([\w-]+)/i.exec(ctype)?.[1];
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (key.toLowerCase() === 'set-cookie') continue; // set-cookie 单独按数组处理
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, String(v)));
    else if (value != null) headers.append(key, String(value));
  }
  const setCookies = res.headers['set-cookie'];
  for (const item of Array.isArray(setCookies) ? setCookies : [setCookies].filter(Boolean)) {
    headers.append('set-cookie', item);
  }
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    url: res.request?.res?.responseUrl || res.config?.url || '',
    headers,
    text: async () => decodeBody(buf, charset),
    json: async () => JSON.parse(decodeBody(buf, charset)),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

/** 网络彻底失败时的空响应：形状与 toResponse 一致，调用方不用判空。 */
const emptyResponse = (error) => ({
  ok: false,
  status: 0,
  url: '',
  error,
  headers: new Headers(),
  text: async () => '',
  json: async () => null,
  arrayBuffer: async () => new ArrayBuffer(0),
});

/** 带超时、限速与重试的请求；失败返回 status=0 的响应对象而不是抛错。 */
async function request(url, options = {}, retries = 2) {
  const { timeout = 20000, referer = true, pace = 350, charset, ...init } = options;
  // Accept 显式保持 */*（axios 默认是 application/json…，对部分站点风控而言是行为差异）
  const headers = { 'User-Agent': UA, Accept: '*/*', ...(init.headers || {}) };
  if (referer && !headers.Referer) headers.Referer = originReferer(url);
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (pace) await paceHost(url, pace);
    try {
      const res = await axios.request({
        url,
        method: init.method || 'get',
        headers,
        data: init.body,
        timeout,
        maxRedirects: 5,
        responseType: 'arraybuffer',
        validateStatus: () => true, // HTTP 错误码不抛异常，交给重试/调用方判断
      });
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      return toResponse(res);
    } catch (err) {
      if (attempt >= retries) return emptyResponse(err.message);
      await sleep(800 * (attempt + 1));
    }
  }
}

/** 按站点声明或 BOM 判定编码，兼容 GBK 页面。 */
function decodeBody(buf, charset) {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  const order = [charset, 'utf-8'].filter(Boolean);
  if (!charset || !/utf-?8/i.test(charset)) order.push('gbk');
  for (const enc of order) {
    try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch { /* 换下一种 */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** GET 文本（自动判编码），失败返回空串。 */
async function getText(url, options = {}) {
  const res = await request(url, options);
  if (!res.ok) return '';
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get('content-type') || '';
  const declared = /charset=([\w-]+)/i.exec(ctype)?.[1] || options.charset;
  return decodeBody(buf, declared);
}

/** GET JSON；网络失败返回 { code:-1 }，由调用方决定降级。 */
async function getJson(url, options = {}) {
  const text = await getText(url, options);
  if (!text) return { code: -1, message: '请求失败' };
  try { return JSON.parse(text); } catch { return { code: -2, message: '响应不是 JSON' }; }
}

/** POST JSON。 */
async function postJson(url, body, options = {}) {
  const text = await getText(url, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  try { return JSON.parse(text); } catch { return { code: -2, message: '响应不是 JSON' }; }
}

/** 逗号分隔的 Cookie 串 → Set-Cookie 数组。 */
function setCookieToHeader(jar, res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const item of raw) {
    const pair = item.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 魔数 → 扩展名，解决无扩展名图片落地后浏览器不渲染的问题。 */
function sniffImageExt(buf) {
  const b = Buffer.from(buf);
  if (b.length < 12) return '.jpg';
  if (b[0] === 0x89 && b[1] === 0x50) return '.png';
  if (b[0] === 0xff && b[1] === 0xd8) return '.jpg';
  if (b.toString('ascii', 0, 3) === 'GIF') return '.gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (b.toString('ascii', 4, 12).includes('ftyp')) return '.avif';
  return '.jpg';
}

/**
 * 下载媒体到本地（头像 / 封面快照）。返回落地的完整路径，失败返回 null。
 * name 由调用方给稳定值，重复下载同一目标会覆盖，不会无限膨胀。
 */
async function downloadMedia(url, targetDir, name, options = {}) {
  if (!url) return null;
  const target = url.startsWith('//') ? 'https:' + url : url;
  const res = await request(target, { referer: false, headers: { Referer: options.referer || originReferer(target) } });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 64) return null;
  const ext = path.extname(new URL(target).pathname) || sniffImageExt(buf);
  const safe = /^\.(png|jpg|jpeg|gif|webp|avif)$/i.test(ext) ? ext.toLowerCase() : sniffImageExt(buf);
  const file = path.join(targetDir, name + safe);
  await fsp.writeFile(file, buf);
  return file;
}

/** 解析「近 x 天 / x 月 / x 年 / 全部」为天数；无法解析按默认 15 天。 */
function parseRangeDays(text, fallback = 15) {
  const value = String(text ?? '').trim();
  if (!value) return fallback;
  if (/全部|all|无限|永久/i.test(value)) return Infinity;
  const m = /(\d+(?:\.\d+)?)\s*(天|日|d|月|m|年|y)/i.exec(value);
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === '月' || unit === 'm') return n * 30;
  if (unit === '年' || unit === 'y') return n * 365;
  return n;
}

module.exports = {
  UA, sleep, md5, request, getText, getJson, postJson, paceHost,
  decodeBody, setCookieToHeader, cookieHeader, originReferer,
  sniffImageExt, downloadMedia, parseRangeDays,
};
