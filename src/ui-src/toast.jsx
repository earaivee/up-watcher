import React from 'react';
import { createRoot } from 'react-dom/client';

/** 浮窗数据由主进程通过 ?data= 传入（encodeURIComponent 的 JSON）。 */
let data = {};
try {
  data = JSON.parse(decodeURIComponent(new URLSearchParams(location.search).get('data') || '')) || {};
} catch { /* 解析失败就显示空壳，别白屏 */ }

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '');

// 点击条目 → window.open 会被主进程的 setWindowOpenHandler 接管，
// 自动进内置浏览器（带登录态），与主界面「在浏览器打开」同一链路。
const openPost = (post) => {
  if (post.link) window.open(post.link, '_blank');
};

// 关闭浮窗：renderer 里 window.close() 即关闭当前 BrowserWindow
const close = () => { try { window.close(); } catch { /* 忽略 */ } };

function Toast() {
  const { source = {}, posts = [] } = data;
  return (
    <div className="toast-body">
      <div className="toast-head" onClick={close} title="点击关闭">
        {source.avatar
          ? <img className="t-avatar" src={source.avatar} alt="" onError={(e) => { e.target.style.display = 'none'; }} />
          : null}
        <span className="t-dot" style={{ background: source.color || '#35c4b5' }} />
        <span className="t-name">{source.name}</span>
        <span className="t-badge">更新了 {posts.length} 条</span>
        <button className="t-close" onClick={close} title="关闭">✕</button>
      </div>
      {posts.map((p) => (
        <div className="t-item" key={p.id} onClick={() => openPost(p)} title="点击查看">
          {p.cover ? <img className="t-cover" src={p.cover} alt="" onError={(e) => { e.target.style.visibility = 'hidden'; }} /> : null}
          <div className="t-info">
            <div className="t-title">{p.title || '（无标题）'}</div>
            <div className="t-meta">
              <span className={'t-kind' + (p.kind === '直播' ? ' live' : '')}>{p.kind || '内容'}</span>
              <span>{fmtTime(p.time)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Toast />);
