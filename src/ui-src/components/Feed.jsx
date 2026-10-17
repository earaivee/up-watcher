import React, { useEffect, useRef, useState } from 'react';
import { Button, Pagination, Segmented, Tag, Tooltip } from 'antd';
import { AppstoreOutlined, BarsOutlined, CheckOutlined } from '@ant-design/icons';
import { fmtTime } from '../api.js';

/** 封面：加载失败回退类型占位。不用懒加载——大图逐张载入会让布局反复跳动。 */
export function Cover({ src, kind, className }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return <div className={className + ' none'}>{kind || '内容'}</div>;
  }
  return <img className={className} src={src} alt="" onError={() => setBroken(true)} />;
}

export function KindTag({ kind }) {
  return <span className={'tag-mini' + (kind === '直播' ? ' live' : '')}>{kind || '内容'}</span>;
}

/** 当前筛选下可见的内容（来源 / 平台 / 内容形式，全部本地过滤）。 */
export function visiblePostsOf({ posts, sourceId, listId, kind }) {
  return posts.filter((p) =>
    (!sourceId || p.sourceId === sourceId)
    && (sourceId || listId === 'all' || p.platformId === listId)
    && (!kind || p.kind === kind));
}

/** 图墙固定列数。 */
const GRID_COLUMNS = 5;

/** 宽:高 → padding-top 百分比（相对宽度），容器高度与图片加载状态完全无关。 */
const padFor = (ratio) => {
  const [w, h] = String(ratio || '16:9').split(':').map(Number);
  return `${((h || 1) / (w || 1)) * 100}%`;
};

export default function Feed(props) {
  const {
    posts, sources, platforms, listId, sourceId, kind, activePostId, read,
    feedView, page, pageSize, prefs,
  } = props;
  const scrollRef = useRef(null);
  const source = sources.find((s) => s.id === sourceId);
  const platform = platforms.find((p) => p.id === listId);
  const title = source ? source.name : (platform ? platform.name : '全部更新');

  // 类型筛选跟随配置的内容形式（订阅 / 平台）；「全部」视图才按实际内容的类型展示。
  const kinds = (source && source.contentTypes) || (platform && platform.contentTypes)
    || [...new Set(posts.map((p) => p.kind).filter(Boolean))];

  // 图墙比例：看订阅/平台分组时用该平台的默认配置（B站 16:9、抖音 9:16）；
  // 「全部」视图是混合内容，统一 16:9。
  const activePlatform = (source && platforms.find((p) => p.id === source.platformId)) || platform || null;
  const gridRatio = (activePlatform && activePlatform.gridRatio) || '16:9';

  const visible = visiblePostsOf({ posts, sourceId, listId, kind });

  /* ---------------- 分页：每页固定条数，筛选变化时由调用方回到第 1 页 ---------------- */
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const pageSafe = Math.min(page || 1, totalPages);
  const paged = visible.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);

  /* 翻页 / 切视图后回到列表顶部。 */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [pageSafe, feedView]);

  return (
    <section className="feed">
      <div className="feed-toolbar">
        <h2>{title}</h2>
        <div className="chips">
          <Tag.CheckableTag checked={!kind} onChange={() => props.onKind(null)}>全部</Tag.CheckableTag>
          {kinds.map((k) => (
            <Tag.CheckableTag key={k} checked={kind === k} onChange={() => props.onKind(k)}>{k}</Tag.CheckableTag>
          ))}
        </div>
        <Segmented
          value={feedView}
          onChange={(v) => props.onFeedView(v)}
          options={[
            { value: 'list', icon: <BarsOutlined /> },
            { value: 'grid', icon: <AppstoreOutlined /> },
          ]}
        />
        <Tooltip title="把当前列表里的内容全部标为已读">
          <Button
            size="small"
            icon={<CheckOutlined />}
            disabled={!visible.some((p) => !read.has(p.id))}
            onClick={props.onMarkAllRead}
          >
            全部已读
          </Button>
        </Tooltip>
      </div>
      <div
        ref={scrollRef}
        className={'posts' + (feedView === 'grid' ? ' grid' : '')}
        style={feedView === 'grid' ? { gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)` } : undefined}
      >
        {visible.length === 0 ? (
          <div className="empty-block">这里还没有内容，添加订阅或点「刷新」。</div>
        ) : feedView === 'grid' ? (
          paged.map((post) => (
            <div
              key={post.id}
              className={'post-grid-item' + (activePostId === post.id ? ' active' : '')}
              onClick={() => props.onOpenPost(post)}
            >
              {/* 比例由 padding-top 百分比锁死，img 绝对定位填满：布局与图片加载状态无关 */}
              <div className="post-grid-cover-box" style={{ paddingTop: padFor(gridRatio) }}>
                <Cover src={post.coverFile || post.cover} kind={post.kind} className="post-grid-cover" />
              </div>
              <div className="post-grid-info">
                <div className="post-grid-title" title={post.title}>{post.title || '（无标题）'}</div>
                <div className="post-grid-meta">
                  <KindTag kind={post.kind} />
                  {read.has(post.id) ? null : <span className="tag-mini unread">未读</span>}
                </div>
              </div>
            </div>
          ))
        ) : (
          paged.map((post) => (
            <div
              key={post.id}
              className={'post' + (activePostId === post.id ? ' active' : '')}
              onClick={() => props.onOpenPost(post)}
            >
              <Cover src={post.coverFile || post.cover} kind={post.kind} className="post-cover" />
              <div className="post-body">
                <div className="post-title" title={post.title}>{post.title || '（无标题）'}</div>
                {post.body ? <div className="post-desc">{post.body}</div> : null}
                <div className="post-foot">
                  {sourceId ? null : <span className="post-author">{post.sourceName || ''}</span>}
                  <KindTag kind={post.kind} />
                  {read.has(post.id) ? null : <span className="tag-mini unread">未读</span>}
                  <span className="post-time">{fmtTime(post.publishedAt)}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      {visible.length > 0 ? (
        <div className="feed-pagination">
          <Pagination
            size="small"
            current={pageSafe}
            pageSize={pageSize}
            total={visible.length}
            showSizeChanger
            pageSizeOptions={[10, 25, 50]}
            showTotal={(t) => `共 ${t} 条`}
            onChange={(p) => props.onPage(p)}
            onShowSizeChange={(_p, size) => { props.onPrefs({ pageSize: size }); props.onPage(1); }}
          />
        </div>
      ) : null}
    </section>
  );
}
