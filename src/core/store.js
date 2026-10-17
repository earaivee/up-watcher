'use strict';
/**
 * 数据持久化：一切都落在数据目录里，跟着程序走（便携）。
 * 结构按「模块（平台）」分文件夹：
 *
 *   <数据目录>/
 *   ├─ _global/            全局：settings.json（设置）、platforms.json（平台注册表，
 *   │                      描述有哪些模块、怎么读取）、live.json（直播状态）、
 *   │                      open-link.log（诊断日志）、legacy/（旧结构迁移留档）
 *   ├─ bilibili/           每个平台一个文件夹：sources.json（该平台的订阅）、
 *   │                      posts.ndjson（内容历史，只追加）、session.json（登录态）
 *   ├─ douyin/…
 *   └─ media/              封面与头像快照（内部已按平台分子目录）
 *
 * 模块关系由 _global/platforms.json 描述：注册表里有哪些平台 id，
 * 就可能存在哪些平台文件夹；读取订阅时再并上实际有数据的文件夹。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR_NAME = 'up-watcher-data';
const LEGACY_DATA_DIR_NAME = 'UPWatcher-data';
const GLOBAL_DIR = '_global';
const LEGACY_DIR = 'legacy';   // 旧结构文件迁移后的留档目录（用户数据只挪不删）
const MISC_DIR = '_misc';      // 没有平台归属的数据的兜底目录

/** 首次运行时写进 _global/ 的配置说明文件名（已存在则不覆盖）。 */
const CONFIG_GUIDE_NAME = '配置说明.txt';

/**
 * 去掉 JSON 文本里的 // 与块注释，字符串内的内容原样保留
 * （配置里常有 http:// 这类 URL，不能被当成行注释误删）。
 * 状态机逐字符扫描：字符串 / 行注释 / 块注释三种状态。
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    // 字符串（JSON 只有双引号，顺手容忍单引号）：整体原样保留，处理转义
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) { out += text[i] + text[i + 1]; i += 2; continue; }
        out += text[i];
        if (text[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    // 行注释：吞到行尾（换行符保留，行号不至于错位）
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    // 块注释：吞到 */
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 配置说明全文。高级配置不走界面，用户照着这份说明手改 json
 * （readJson 已容忍注释，用户写笔记也不影响读取）。
 */
const CONFIG_GUIDE = [
  '你快更新啊 —— 配置说明',
  '======================',
  '',
  '数据目录里放着你所有的订阅、历史记录和配置。这份文件告诉你哪些能改、怎么改。',
  '',
  '【目录结构】',
  '  _global/',
  '    settings.json      全局设置（刷新间隔、通知方式等）',
  '    platforms.json     平台注册表（怎么去各个网站抓数据）',
  '    live.json          直播状态缓存（程序自动维护，不用管）',
  '    配置说明.txt       就是本文件',
  '    legacy/            旧版本迁移留下的存档，可删',
  '  bilibili/            每个平台一个文件夹',
  '    sources.json       该平台的订阅列表',
  '    posts.ndjson       内容历史（只增不删的程序数据，别手改）',
  '    session.json       登录态（程序自动维护，别手改）',
  '  douyin/ ...',
  '  media/               封面与头像快照（自动管理，删了就没了）',
  '',
  '【通用规则】',
  '  1. settings.json / platforms.json 支持 // 行注释 和 /* */ 块注释，可放心写笔记。',
  '     （注意：注释只在这两个配置里有效，其它 json 是程序自动读写的，别加。）',
  '  2. 改完配置要重启程序才生效。',
  '  3. 在界面里改平台名称/颜色并保存时，platforms.json 会被整个重写，',
  '     你手写的注释会丢。重要注释建议留一份备份（如 platforms.备份.json），',
  '     或改完界面后再补回来。',
  '  4. 改坏了不要慌：把该文件删掉（或改名），程序下次启动会按默认配置重建；',
  '     订阅与历史在别的文件里，不受影响。',
  '',
  '【_global/settings.json —— 全局设置】',
  '{',
  '  // 回看范围（天）：添加新订阅时往回抓多早的内容',
  '  "range": 15,',
  '  // 自动刷新间隔（分钟），最小 5',
  '  "intervalMinutes": 20,',
  '  // 每轮增量检查，单个订阅最多处理多少条新内容',
  '  "incrementalLimit": 12,',
  '  // 通知方式："toast"=应用内浮窗；"native"=系统通知；"both"=两者都要',
  '  "notifyMode": "toast",',
  '  // 每个订阅每次最多提示几条',
  '  "notifyLimit": 3',
  '}',
  '以上字段都可省略，省略时按上述默认值处理。',
  '',
  '【_global/platforms.json —— 平台注册表】',
  '结构：{ "version": 3, "platforms": [ ...平台定义数组... ] }',
  '注意：version 与程序内置版本不一致时，整个文件会被忽略、按内置配置运行',
  '（升级保护，防止旧格式读出新错）。当前内置版本是 3，别改它。',
  '',
  '每个平台定义的常用字段（以 B站 为例）：',
  '{',
  '  "id": "bilibili",               // 平台唯一标识，改了会被当成新平台',
  '  "name": "B站",                  // 显示名称',
  '  "color": "#00a1d6",             // 主题色',
  '  "gridRatio": "16:9",            // 图墙封面宽高比（B站 16:9、抖音 9:16），不写按 16:9',
  '  "builtin": true,                // 是否内置平台（内置的不能删）',
  '  "contentTypes": ["视频", "动态"], // 该平台的内容分类',
  '  "historyMaxDays": 3650,         // 最多往回追多少天',
  '  "supportsRange": true,          // 是否支持按时间范围回溯',
  '  "pageSize": 30,                 // 每页条数（分页抓取用）',
  '  "maxPages": 12,                 // 单次抓取最多翻几页',
  '  "order": "desc",                // 接口排序：desc=新到旧',
  '  "driver": "http",               // 抓取驱动：',
  '                                  //   http   = 调 JSON 接口，按 mapper 取字段',
  '                                  //   generic= 打开网页按选择器抓',
  '                                  //   browser= 内置专用浏览器（抖音专用）',
  '  "identifyRules": [              // 怎么识别用户输入的订阅地址（正则）',
  '    { "pattern": "space\\\\.bilibili\\\\.com/(\\\\d+)", "hint": "UID" }',
  '  ],',
  '  "urls": {                       // 接口地址（driver=http 时使用）',
  '    "list":    "...列表接口...",   //   {sourceKey}=订阅标识  {page}=页码',
  '    "profile": "...资料接口...",',
  '    "detail":  "...详情接口...",',
  '    "live":    "...直播状态接口..."',
  '  },',
  '  "mapper": {                     // 接口返回的 JSON 里字段在哪（点路径）',
  '    "list": "data.list.vlist",    //   内容数组的位',
  '    "hasMore": "data.page.count", //   还有更多内容的判断依据',
  '    "item": {                     //   每条内容字段 -> JSON 路径',
  '      "id": "bvid", "title": "title", "body": "description",',
  '      "cover": "pic", "time": "created", "kind": "type"',
  '    },',
  '    "profile": { "name": "name", "face": "face", "sign": "sign" }',
  '  },',
  '  "login": {                      // 登录配置',
  '    "entry": "登录页地址",',
  '    "cookieUrl": "取 cookie 的域名",',
  '    "verifyUrl": "校验登录态的接口",',
  '    "verifyPath": "data.isLogin", //   接口返回里哪个字段表示已登录',
  '    "cookieNames": ["SESSDATA"],  //   哪些 cookie 算登录凭证',
  '    "gate": "soft",               //   soft=未登录时降级/提示，不强拦',
  '    "hint": "给用户看的提示文字"',
  '  },',
  '  "browser": {                    // 网页抓取配置（driver=generic / 降级时用）',
  '    "pageUrl": "...主页地址...",   //   {sourceKey} 会被替换成订阅标识',
  '    "itemSelectors": {            //   CSS 选择器；"a@href" 表示取 a 元素的 href',
  '      "item": "div.post", "title": "h3", "link": "a@href",',
  '      "cover": "img@src", "time": "time@datetime"',
  '    }',
  '  },',
  '  "fallback": { "mode": "page" }  // 接口失败时的兜底方式：page=改开网页抓',
  '}',
  '',
  '抖音（douyin）特有的字段：',
  '  "capture": { "profile": "...", "list": "...", "live": "..." }',
  '      // 拦截哪些接口（路径前缀），驱动内部使用，一般不用改',
  '  "scrollTimes": 2, "scrollDelay": 1800, "settleMs": 1500',
  '      // 网页滚动次数 / 每次滚动后等待毫秒 / 内容稳定等待毫秒',
  '',
  '【改配置的建议流程】',
  '  1. 先备份要改的文件（复制一份，改名加 .bak）。',
  '  2. 用记事本或 VSCode 打开，小步修改，保存。',
  '  3. 重启程序看效果；出问题就还原备份。',
  '',
  '—— 完 ——',
].join('\r\n') + '\r\n';

class Store {
  constructor(root) {
    this.root = root;
    this.mediaDir = path.join(root, 'media');
    fs.mkdirSync(path.join(root, GLOBAL_DIR), { recursive: true });
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this._index = new Map();
    this.migrate();
    this._ensureConfigGuide();
    this._loadArchive();
  }

  /**
   * 首次运行时在 _global/ 生成一份带完整注释的配置说明（已存在则不覆盖，
   * 用户可能自己维护过它）。高级配置不走界面，用户照着这份说明改配置文件。
   */
  _ensureConfigGuide() {
    const file = this.globalPath(CONFIG_GUIDE_NAME);
    if (fs.existsSync(file)) return;
    try {
      fs.mkdirSync(path.join(this.root, GLOBAL_DIR), { recursive: true });
      fs.writeFileSync(file, CONFIG_GUIDE, 'utf8');
    } catch { /* 只读目录写不进就算了 */ }
  }

  /** 数据目录里的任意路径（支持子目录，如 'bilibili/sources.json'）。 */
  file(rel) { return path.join(this.root, rel); }

  /** 需要目录时先建好再返回（media 子目录、平台文件夹都用它）。 */
  dir(rel) {
    const d = this.file(rel);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  /**
   * 读 JSON：容忍 // 与 /* *​/ 注释——配置文件是给用户手改的（platforms.json / settings.json），
   * 用户加注释说明后程序照样能读。程序自己写出的仍是纯 JSON。
   */
  readJson(rel, fallback) {
    try { return JSON.parse(stripComments(fs.readFileSync(this.file(rel), 'utf8'))); }
    catch { return fallback; }
  }

  writeJson(rel, value) {
    const full = this.file(rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = full + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, full);
  }

  /* ------------------------- 全局文件（_global/） ------------------------- */

  globalPath(name) { return path.join(this.root, GLOBAL_DIR, name); }

  readGlobal(name, fallback) { return this.readJson(path.join(GLOBAL_DIR, name), fallback); }

  writeGlobal(name, value) { this.writeJson(path.join(GLOBAL_DIR, name), value); }

  /* ---------------- 订阅：对外一张列表，落盘按平台分文件 ---------------- */

  /** 聚合所有平台文件夹里的订阅。 */
  readAllSources() {
    const list = [];
    for (const pid of this.platformDirs()) {
      const group = this.readJson(path.join(pid, 'sources.json'), []);
      if (Array.isArray(group)) list.push(...group);
    }
    return list;
  }

  /** 按平台分组写入各平台文件夹（platformId 缺失的归入 _misc）。 */
  writeSources(list) {
    const groups = new Map();
    for (const s of list || []) {
      const pid = s.platformId || MISC_DIR;
      if (!groups.has(pid)) groups.set(pid, []);
      groups.get(pid).push(s);
    }
    for (const [pid, group] of groups) this.writeJson(path.join(pid, 'sources.json'), group);
  }

  /** 实际存在数据（订阅/历史/登录态任一）的平台文件夹名。 */
  platformDirs() {
    const out = new Set();
    let entries = [];
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return [...out]; }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name === GLOBAL_DIR || ent.name === 'media' || ent.name.startsWith('.')) continue;
      const base = path.join(this.root, ent.name);
      if (fs.existsSync(path.join(base, 'sources.json'))
        || fs.existsSync(path.join(base, 'posts.ndjson'))
        || fs.existsSync(path.join(base, 'session.json'))) {
        out.add(ent.name);
      }
    }
    return [...out];
  }

  /* ---------------- 内容历史：只增不删，按平台分文件 ---------------- */

  archivePath(platformId) { return path.join(this.root, platformId || MISC_DIR, 'posts.ndjson'); }

  /** 启动时把各平台的历史日志读进内存索引，供界面与去重使用。 */
  _loadArchive() {
    for (const pid of this.platformDirs()) {
      let raw = '';
      try { raw = fs.readFileSync(this.archivePath(pid), 'utf8'); } catch { continue; }
      this._ingestLines(raw);
    }
  }

  _ingestLines(raw) {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const post = JSON.parse(line);
        // 分类修正（幂等）：动态流里带视频的动态曾被标成「视频」，
        // 按链接形态归位——t.bilibili.com 链接的一律是动态，BV 视频页才是投稿视频。
        if (post.platform === 'bilibili' && post.kind === '视频'
          && /^https?:\/\/t\.bilibili\.com\//.test(post.link || '')) {
          post.kind = '动态';
        }
        this._index.set(post.id, post);
      } catch { /* 跳过坏行 */ }
    }
  }

  postsOf(sourceId) { return [...this._index.values()].filter((p) => p.sourceId === sourceId); }

  hasPost(id) { return this._index.has(id); }

  getPost(id) { return this._index.get(id) || null; }

  /**
   * 追加一条同 id 的更新记录（如给旧内容事后补封面快照）。
   * 历史文件只增不删；同 id 多行时加载以最后一行为准（Map.set 后写覆盖先写）。
   */
  upsertPost(post) {
    this._index.set(post.id, post);
    const full = this.archivePath(post.platform || MISC_DIR);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.appendFileSync(full, JSON.stringify(post) + '\n', 'utf8');
  }

  /** 追加一条历史：以 id 去重，写进内容所属平台的文件夹。 */
  appendPost(post) {
    if (this._index.has(post.id)) return false;
    this._index.set(post.id, post);
    const full = this.archivePath(post.platform || MISC_DIR);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.appendFileSync(full, JSON.stringify(post) + '\n', 'utf8');
    return true;
  }

  /* ---------------- 登录态：每个平台文件夹一个 session.json ---------------- */

  sessionPath(platformId) { return path.join(platformId || MISC_DIR, 'session.json'); }

  readSession(platformId) { return this.readJson(this.sessionPath(platformId), {}); }

  writeSession(platformId, value) { this.writeJson(this.sessionPath(platformId), value); }

  /* ---------------- 旧结构迁移（幂等，可安全重入） ---------------- */

  migrate() {
    const park = (name) => {
      // 旧文件不删，统一挪进 _global/legacy/ 留档
      try {
        const legacyDir = path.join(this.root, GLOBAL_DIR, LEGACY_DIR);
        fs.mkdirSync(legacyDir, { recursive: true });
        fs.renameSync(this.file(name), path.join(legacyDir, name));
      } catch { /* 已迁过 / 不存在 / 占用中（下次启动再试） */ }
    };

    // 1) 全局配置：settings.json / platforms.json / live.json → _global/
    for (const name of ['settings.json', 'platforms.json', 'live.json']) {
      if (!fs.existsSync(this.globalPath(name)) && fs.existsSync(this.file(name))) {
        this.writeGlobal(name, this.readJson(name, {}));
        park(name);
      }
    }

    // 2) 登录态：session-<平台>.json → <平台>/session.json
    let entries = [];
    try { entries = fs.readdirSync(this.root); } catch { entries = []; }
    for (const name of entries) {
      const m = /^session-([\w.-]+)\.json$/.exec(name);
      if (!m) continue;
      const pid = m[1];
      if (!fs.existsSync(this.file(this.sessionPath(pid)))) {
        this.writeSession(pid, this.readJson(name, {}));
      }
      park(name);
    }

    // 3) 订阅：sources.json（根）→ 各平台文件夹
    const legacySources = this.readJson('sources.json', null);
    if (Array.isArray(legacySources)) {
      const groups = new Map();
      for (const s of legacySources) {
        const pid = s.platformId || MISC_DIR;
        if (!groups.has(pid)) groups.set(pid, []);
        groups.get(pid).push(s);
      }
      for (const [pid, group] of groups) {
        // 与已有文件合并去重，保证迁移可重入
        const existing = this.readJson(path.join(pid, 'sources.json'), []);
        const seen = new Set(existing.map((s) => s.id));
        const fresh = group.filter((s) => !seen.has(s.id));
        this.writeJson(path.join(pid, 'sources.json'), [...existing, ...fresh]);
      }
      park('sources.json');
    }

    // 4) 历史：posts.ndjson（根）→ 按内容所属平台分文件（合并去重，可重入）
    const legacyPosts = this.file('posts.ndjson');
    if (fs.existsSync(legacyPosts)) {
      let raw = '';
      try { raw = fs.readFileSync(legacyPosts, 'utf8'); } catch { raw = ''; }
      const groups = new Map(); // pid -> [post对象]
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const post = JSON.parse(line);
          const pid = post.platform || MISC_DIR;
          if (!groups.has(pid)) groups.set(pid, []);
          groups.get(pid).push(post);
        } catch { /* 跳过坏行 */ }
      }
      for (const [pid, posts] of groups) {
        const full = this.archivePath(pid);
        const seen = new Set();
        try {
          for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
            if (line.trim()) { try { seen.add(JSON.parse(line).id); } catch { /* 坏行 */ } }
          }
        } catch { /* 目标还不存在 */ }
        const fresh = posts.filter((p) => !seen.has(p.id));
        if (fresh.length) {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.appendFileSync(full, fresh.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
        }
      }
      park('posts.ndjson');
    }
  }
}

module.exports = { Store, DATA_DIR_NAME, LEGACY_DATA_DIR_NAME, GLOBAL_DIR };
