'use strict';
/**
 * 运行日志（数据目录 _global/app.log）：每次启动重写，只保留本次运行的过程。
 *
 * 为什么不追加：这工具的毛病大多是「这次启动之后不对」，
 * 留着几十次启动的历史只会让排错的人在上万行里翻找；一次一份、干净利落。
 *
 * 边界：只记「做了什么、出了什么错」，不记抓取到的内容正文，
 * 也不记 cookie / 登录凭证——日志是要能直接发出去给人看的。
 */

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'app.log';
const MAX_BYTES = 1024 * 1024; // 异常循环时日志会疯长，到量就停写（磁盘不能被日志拖死）
const MAX_LINE = 500;          // 单行截断，防止一整页 HTML 被塞进来

/** 12:03:04.321 —— 一天内够定位，不写日期省得每行都长。 */
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

class Logger {
  constructor(dir) {
    this.file = path.join(dir, FILE_NAME);
    this.bytes = 0;
    this.stopped = false;
    this.verbose = false; // 开发态顺带打到控制台，打包后不刷屏
  }

  /** 每次启动调用一次：清空旧日志，写上本次运行的环境。 */
  start(head = []) {
    this.bytes = 0;
    this.stopped = false;
    const lines = ['===== 启动 ' + new Date().toLocaleString('zh-CN', { hour12: false }) + ' =====', ...head, ''];
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, lines.join('\n'), 'utf8');
      this.bytes = Buffer.byteLength(lines.join('\n'), 'utf8');
    } catch { /* 数据目录只读就写不了，程序照跑 */ }
  }

  line(level, msg) {
    const text = `[${stamp()}] ${level} ${String(msg ?? '').replace(/\s+/g, ' ').slice(0, MAX_LINE)}`;
    if (this.verbose) console.log(text);
    if (this.stopped) return;
    try {
      fs.appendFileSync(this.file, text + '\n', 'utf8');
      this.bytes += Buffer.byteLength(text, 'utf8') + 1;
      if (this.bytes > MAX_BYTES) {
        this.stopped = true;
        fs.appendFileSync(this.file, `[${stamp()}] WARN 日志超过 ${Math.round(MAX_BYTES / 1024)}KB，停止记录\n`, 'utf8');
      }
    } catch { /* 日志写不进就算了 */ }
  }

  info(msg) { this.line('INFO', msg); }
  warn(msg) { this.line('WARN', msg); }
  error(msg) { this.line('ERROR', msg); }
}

module.exports = { Logger, FILE_NAME };
