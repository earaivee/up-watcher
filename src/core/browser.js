'use strict';
/**
 * 隐藏窗口 + CDP 抓包。
 * 抖音的接口带 a_bogus / X-Bogus 签名与 uifid 校验，纯 HTTP 必被 ArgusSecurityPlugin 拦，
 * 只能让页面自己的 JS 去签名请求，我们从 CDP 截响应。
 *
 * 实测坑（需求文档第 4 节，全部在此规避）：
 *  - 必须等 dom-ready 之后再 attach 调试器并 Network.enable，导航开始前挂会让命令永久挂起；
 *  - await win.loadURL() 会卡死（长轮询页面 onload 不触发），要「后台加载 + 统一超时」；
 *  - 销毁窗口前要停掉在飞行中的 getResponseBody，否则报 target closed（噪音）。
 */

const { BrowserWindow, session } = require('electron');
const net = require('./net');

const PARTITION = 'persist:upwatcher';

class BrowserSession {
  constructor() { this.win = null; this.attached = false; this.rules = []; this.pending = new Set(); }

  /** 登录态所在的分区：隐藏窗口与登录窗口共用，登录一次到处生效。 */
  static partition() { return PARTITION; }

  static partitionSession() { return session.fromPartition(PARTITION); }

  /** 窗口里的 Cookie → 纯对象，用于落盘。 */
  static async readCookies(url) {
    const list = await BrowserSession.partitionSession().cookies.get({ url });
    const jar = {};
    for (const c of list) jar[c.name] = c.value;
    return jar;
  }

  /**
   * 打开（或复用）隐藏窗口。
   * 注意：这里不做「已在该地址就跳过导航」的优化 —— 截包靠的是响应事件，
   * 不重新导航就拿不到任何响应，第二轮回溯会静默抓到 0 条。
   */
  async open(url) {
    if (!this.win || this.win.isDestroyed()) this.win = this.createWindow();
    if (!this.attached) await this.attach();
    if (url) await net.paceHost(url, 500);
    return this.win;
  }

  createWindow() {
    return new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition: PARTITION,
        offscreen: false,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
  }

  /** 等 dom-ready 之后再挂调试器 —— 早挂会让命令永久挂起。 */
  async attach() {
    const wc = this.win.webContents;
    if (!wc.getURL() || wc.getURL() === 'about:blank') {
      // 用一个真实页面兜住「dom-ready 之后才能挂调试器」这条硬性顺序
      const started = Date.now();
      const loaded = new Promise((resolve) => {
        wc.once('dom-ready', resolve);
        setTimeout(resolve, 2000);
      });
      wc.loadURL('https://www.bing.com/').catch(() => { /* 失败由超时兜底 */ });
      const ok = await Promise.race([loaded.then(() => true), new Promise((r) => setTimeout(() => r(false), 8000))]);
      await net.sleep(ok ? 200 : Math.max(0, 2000 - (Date.now() - started)));
    }
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize: 256 * 1024 * 1024,
      maxResourceBufferSize: 64 * 1024 * 1024,
    });
    wc.debugger.on('message', (_e, method, params) => this.onCdp(method, params));
    this.attached = true;
  }

  /** 注册一个截包规则：urlIncludes 命中后把响应体交给 onBody。 */
  capture(urlIncludes, onBody) {
    this.rules.push({ urlIncludes, onBody });
  }

  clearRules() { this.rules = []; }

  /** CDP 事件分发：只处理响应完成事件。 */
  onCdp(method, params) {
    if (method !== 'Network.responseReceived') return;
    const { requestId, response, type } = params;
    const rule = this.rules.find((r) => String(response.url).includes(r.urlIncludes));
    if (!rule) return;
    if (type && !['XHR', 'Fetch', 'Document'].includes(type)) return;
    this.readBody(requestId, rule, response).catch(() => { /* 目标已关闭等噪音，忽略 */ });
  }

  /** 读响应体并交给规则；飞行中的请求会登记，关窗时统一放弃。 */
  async readBody(requestId, rule, response) {
    const task = (async () => {
      try {
        const res = await this.win.webContents.debugger.sendCommand('Network.getResponseBody', { requestId });
        const text = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
        if (text && text.length > 2) await rule.onBody(text, response.url);
      } catch { /* 缓冲已回收，忽略 */ }
    })();
    this.pending.add(task);
    try { await task; } finally { this.pending.delete(task); }
  }

  /** 后台加载 + 统一超时：不用 await loadURL，避免长轮询页面把命令挂死。 */
  async goto(url, timeoutMs = 30000) {
    await this.open(url);
    const wc = this.win.webContents;
    await new Promise((resolve) => {
      let timer = null;
      // 三个监听都要摘干净：反复 goto 同一个窗口会累积监听器
      const done = () => {
        if (timer) clearTimeout(timer);
        wc.removeListener('dom-ready', done);
        wc.removeListener('did-fail-load', done);
        resolve();
      };
      wc.once('dom-ready', done);
      wc.once('did-fail-load', done);
      timer = setTimeout(done, timeoutMs);
      wc.loadURL(url).catch(() => { /* 失败由超时兜底 */ });
    });
    await net.sleep(this.def?.settleMs || 1200);
    return this.win;
  }

  /** 在页面里执行 JS，超时/失败返回 null。 */
  async eval(script, timeoutMs = 15000) {
    if (!this.win || this.win.isDestroyed()) return null;
    const racer = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const run = this.win.webContents.executeJavaScript(script, true).catch(() => null);
    return Promise.race([run, racer]);
  }

  /**
   * 打开页面并截屏，返回 PNG Buffer（失败返回 null）。给无图内容做封面快照用。
   * 至少等 10 秒再截：实测 2-3 秒时页面还没加载完，截出来是半成品；
   * 中途先滚一屏再回顶，触发图片懒加载，避免截到占位图。
   */
  async captureScreenshot(url) {
    try {
      await this.goto(url, 30000);
      await this.eval('window.scrollTo(0, Math.max(600, document.body.scrollHeight * 0.6))').catch(() => {});
      await net.sleep(3000);  // 滚动后等懒加载图片请求回来
      await this.eval('window.scrollTo(0, 0)').catch(() => {});
      await net.sleep(7000);  // 回顶后再等页面与图片渲染完
      const image = await this.win.webContents.capturePage();
      return image && !image.isEmpty() ? image.toPNG() : null;
    } catch {
      return null;
    }
  }

  /** 滚动若干次，每次间隔 delayMs —— 滚动次数不要贪多，缓冲会回收。 */
  async scroll(times = 2, delayMs = 1800) {
    for (let i = 0; i < times; i++) {
      await this.eval(`(() => { window.scrollTo(0, document.body.scrollHeight); return document.body.scrollHeight; })()`);
      await net.sleep(delayMs);
    }
  }

  /** 关窗：先等在飞行中的响应体读完，再销毁，避免 target closed 噪音。 */
  async close() {
    if (!this.win || this.win.isDestroyed()) { this.win = null; this.attached = false; return; }
    await Promise.race([Promise.allSettled([...this.pending]), net.sleep(1500)]);
    try { if (this.win.webContents.debugger.isAttached()) this.win.webContents.debugger.detach(); } catch { /* 已断开 */ }
    this.win.destroy();
    this.win = null;
    this.attached = false;
  }
}

module.exports = { BrowserSession, PARTITION };
