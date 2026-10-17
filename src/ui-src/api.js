/** 渲染层与主进程的唯一通道（preload 注入的 window.up）。 */
export const api = window.up;

export const POST_LIMIT = 10000; // 大 UP 全量回溯可能有几千条，一次拉全本地筛

export const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });

/** 数据目录里的相对路径 → 本地 file:// 地址（封面快照 / 头像等）。 */
export const mediaUrl = (rel, dataRoot) => {
  if (!rel) return '';
  const base = (dataRoot || '').replace(/[\\/]+$/, '');
  const abs = base ? `${base}/${rel.replace(/^[\\/]+/, '')}` : rel;
  return `file:///${abs.replace(/\\/g, '/').replace(/^\/+/, '')}`;
};

export const RANGE_OPTIONS = ['7天', '15天', '1月', '3月', '1年', '全部'];
