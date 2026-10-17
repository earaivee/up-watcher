import React, { useEffect, useState } from 'react';
import { Button, Checkbox, Empty, Input, Modal, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { api } from '../api.js';
import { toast } from '../message.js';
import { FAvatar } from './Sidebar.jsx';

/**
 * 从我的关注里挑选订阅（独立弹窗）：
 * 支持按昵称/签名搜索、多选、一键订阅所选。已订阅的置灰不可再选。
 */
export default function FollowingsModal({ open, platform, sources, loginTick, onClose, onRefresh, onLogin }) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!platform) return;
    setLoading(true);
    setError(null);
    setItems(null);
    setSelected(new Set());
    const res = await api.sources.followings(platform.id);
    setLoading(false);
    if (!res.ok) return setError(res.error);
    setItems(res.data.items || []);
  };

  useEffect(() => {
    if (!open) return;
    setKeyword('');
    if (platform && platform.needsLogin && !platform.loggedIn) return; // 未登录：先展示登录引导
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, platform && platform.id]);

  /* 登录成功后（loginTick 变化）自动拉取 */
  useEffect(() => {
    if (!open || !platform) return;
    if (platform.needsLogin && platform.loggedIn && !items && !loading && !error) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginTick]);

  if (!platform) return null;

  const subscribedKeys = new Set(
    sources.filter((s) => s.platformId === platform.id).map((s) => s.platformKey));
  const kw = keyword.trim().toLowerCase();
  const filtered = (items || []).filter((item) =>
    !kw || `${item.name}${item.sign || ''}`.toLowerCase().includes(kw));
  const pickable = filtered.filter((i) => !subscribedKeys.has(i.key));

  const toggle = (item) => {
    if (subscribedKeys.has(item.key)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.key)) next.delete(item.key);
      else next.add(item.key);
      return next;
    });
  };

  const subscribeSelected = async () => {
    const targets = pickable.filter((i) => selected.has(i.key));
    if (!targets.length) return;
    setBusy(true);
    let okCount = 0;
    let lastError = '';
    for (const item of targets) {
      const res = await api.sources.add({ input: item.key, platformId: platform.id, name: item.name });
      if (res.ok) okCount += 1;
      else lastError = res.error;
    }
    setBusy(false);
    if (okCount) toast(`已订阅 ${okCount} 位博主`, 'ok');
    if (lastError) toast(`部分失败：${lastError}`, 'err');
    await onRefresh();
    if (okCount && !lastError) onClose();
  };

  const body = () => {
    if (platform.needsLogin && !platform.loggedIn) {
      return (
        <div style={{ textAlign: 'center', padding: '28px 0' }}>
          <p style={{ opacity: 0.7 }}>{platform.name} 还没登录，登录后才能读取关注列表。</p>
          <Button type="primary" onClick={() => onLogin(platform.id)}>去登录</Button>
        </div>
      );
    }
    if (loading) return <div style={{ textAlign: 'center', padding: '28px 0', opacity: 0.6 }}>正在读取关注列表…</div>;
    if (error) return <Empty description={`读取失败：${error}`} />;
    if (!items) return null;
    if (!items.length) return <Empty description="关注列表是空的" />;
    return (
      <>
        <div style={{ marginBottom: 10 }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder={`搜索 ${items.length} 个关注（昵称 / 签名）`}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className="follow-box">
          {filtered.length === 0 ? (
            <div className="empty-note" style={{ textAlign: 'center', padding: 16 }}>没有匹配的博主</div>
          ) : filtered.map((item) => {
            const already = subscribedKeys.has(item.key);
            const checked = already ? true : selected.has(item.key);
            return (
              <div
                key={item.key || item.name}
                className={'follow-item' + (checked && !already ? ' picked' : '')}
                style={{ opacity: already ? 0.45 : 1, cursor: already ? 'default' : 'pointer' }}
                onClick={() => toggle(item)}
              >
                <Checkbox checked={checked} disabled={already} onClick={(e) => e.stopPropagation()} />
                <FAvatar src={item.avatarUrl} name={item.name} size={30} />
                <span className="follow-name" title={item.sign || item.name}>{item.name}</span>
                {already ? <Tag>已订阅</Tag> : null}
              </div>
            );
          })}
        </div>
      </>
    );
  };

  return (
    <Modal
      open={open}
      title={`从我的关注里选 · ${platform.name}`}
      width={480}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button
          key="ok" type="primary" loading={busy}
          disabled={!selected.size}
          onClick={subscribeSelected}
        >
          订阅所选（{selected.size}）
        </Button>,
      ]}
    >
      {body()}
    </Modal>
  );
}
