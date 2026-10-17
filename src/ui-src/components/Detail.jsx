import React, { useState } from 'react';
import { Button, Image, Tooltip, Typography } from 'antd';
import { ExportOutlined, CameraOutlined, PictureOutlined } from '@ant-design/icons';
import { fmtTime, mediaUrl } from '../api.js';
import { KindTag } from './Feed.jsx';

function InfoRow({ label, value, link }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      {value
        ? (link
          ? <Typography.Text className="info-value" style={{ flex: 1 }} ellipsis={{ tooltip: value }} copyable={{ text: value }}>{value}</Typography.Text>
          : <span className="info-value" title={value}>{value}</span>)
        : <span className="info-value" style={{ opacity: 0.4 }}>（无）</span>}
    </div>
  );
}

export default function Detail({ post, sources, dataRoot, onOpenLink, onSnapshot }) {
  const [shotting, setShotting] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);

  if (!post) {
    return (
      <aside className="detail">
        <div className="empty-detail">
          <p>选中一条内容查看详情</p>
          <span>历史只增不删，平台删了这里也在</span>
        </div>
      </aside>
    );
  }

  const source = sources.find((s) => s.id === post.sourceId);
  const canOpen = !!(post.link || (source && source.homeUrl));
  const hasCover = !!(post.coverFile || post.cover);

  const doSnapshot = async () => {
    setShotting(true);
    try { await onSnapshot(post); } finally { setShotting(false); }
  };

  return (
    <aside className="detail">
      {hasCover ? (
        <Image
          className="detail-cover"
          src={post.coverFile || mediaUrl(post.cover, dataRoot)}
          alt="封面"
          preview={{ open: coverOpen, onVisibleChange: (vis) => setCoverOpen(vis) }}
        />
      ) : null}

      {post.avatarFile ? (
        <Tooltip title="抓取时的作者头像（博主换头像后，旧内容仍显示当时的头像）">
          <img className="detail-avatar" src={post.avatarFile} alt="" />
        </Tooltip>
      ) : null}

      <h3 className="detail-title">{post.title || '（无标题）'}</h3>

      <div className="detail-meta">
        <KindTag kind={post.kind} />
        <span>{post.sourceName || ''}</span>
        <span>{fmtTime(post.publishedAt)}</span>
        {post.fallback ? <span className="tag-mini">兜底抓取</span> : null}
      </div>

      <div className="detail-text">{post.body || '（这条内容没有正文）'}</div>

      {post.screenshot ? (
        <Tooltip title="页面兜底抓取时留下的整页快照，点击放大">
          <Image
            className="detail-shot"
            src={mediaUrl(post.screenshot, dataRoot)}
            alt="页面快照"
          />
        </Tooltip>
      ) : null}

      <div className="detail-info">
        <InfoRow label="原文链接" value={post.link || ''} link />
        <InfoRow label="内容编号" value={String(post.id || '').split(':').slice(2).join(':') || post.id || ''} />
        <InfoRow label="发布时间" value={post.publishedAt ? fmtTime(post.publishedAt) : ''} />
        <InfoRow label="抓取时间" value={post.capturedAt ? fmtTime(post.capturedAt) : ''} />
        {post.coverUrl ? <InfoRow label="封面原图" value={post.coverUrl} link /> : null}
        {post.fallback ? <InfoRow label="抓取方式" value="页面兜底抓取" /> : null}
      </div>

      <div className="detail-actions">
        <Button
          type="primary" icon={<ExportOutlined />}
          disabled={!canOpen}
          title={post.link ? '' : '这条内容没有原文链接'}
          onClick={() => onOpenLink(post)}
        >
          在浏览器打开
        </Button>
        {hasCover ? (
          <Button icon={<PictureOutlined />} onClick={() => setCoverOpen(true)}>
            查看封面快照
          </Button>
        ) : (post.link ? (
          <Button icon={<CameraOutlined />} loading={shotting} onClick={doSnapshot}
            title="打开原文页面截一张图存为封面">
            截取动态快照
          </Button>
        ) : null)}
      </div>
    </aside>
  );
}
