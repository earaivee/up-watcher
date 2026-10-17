import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Tag } from 'antd';
import { SnippetsOutlined, TeamOutlined } from '@ant-design/icons';
import { api, RANGE_OPTIONS } from '../api.js';

/**
 * 添加订阅：平台瓦片（自动识别 + 各平台）+ 地址输入。
 * 回看历史只对自定义平台显示（内置平台默认跟随全局设置）；
 * 「从我的关注里选」需要先选定平台，弹独立窗口挑选（支持搜索/多选）。
 */
export default function AddModal({ open, settings, platforms, onClose, onOpenFollowings }) {
  const [platformId, setPlatformId] = useState(null); // null = 自动识别
  const [input, setInput] = useState('');
  const [range, setRange] = useState('15天');
  const [kinds, setKinds] = useState([]);              // 勾选的内容形式
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPlatformId(null);
    setInput('');
    setRange(settings.range || '15天');
    setKinds([]);
    setResult(null);
  }, [open, settings.range]);

  const platform = platforms.find((p) => p.id === platformId) || null;

  const inputHint = platform
    ? ({ bilibili: '例如 space.bilibili.com/xxxxxxxx，或直接填数字 UID',
        douyin: '例如 douyin.com/user/xxxxxx…，或粘贴 App 里的分享文本' }[platform.id]
      || `填写 ${platform.name} 的主页地址或用户 id`)
    : '支持主页链接、用户 id、App 分享文本';

  const pickPlatform = (id) => {
    setPlatformId(id);
    setResult(null);
    const p = platforms.find((x) => x.id === id);
    setKinds(p ? (p.contentTypes || []) : []);
  };

  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return setResult({ type: 'error', title: '剪贴板是空的', body: '把博主的主页链接、用户 id，或 App 里「复制链接」的内容粘到上面。' });
      setInput(text);
    } catch {
      setResult({ type: 'error', title: '读不到剪贴板', body: '请手动 Ctrl+V 粘贴到输入框。' });
    }
  };

  const toggleKind = (kind) => {
    setKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));
  };

  const doAdd = async () => {
    const text = input.trim();
    if (!text) {
      return setResult({ type: 'error', title: '还没填地址', body: '把博主的主页链接、用户 id，或 App 里「复制链接」的内容粘到上面。' });
    }
    setBusy(true);
    try {
      const res = await api.sources.add({
        input: text,
        platformId: platformId || undefined,
        contentTypes: platformId ? kinds : undefined,
        // 内置平台不展示回看选项：跟随全局设置即可
        range: platform && !platform.builtin ? range : undefined,
      });
      if (!res.ok) return setResult({ type: 'error', title: '没能订阅', body: res.error });
      setResult({ type: 'success', title: `已订阅：${res.data.name}`, body: '正在后台回溯历史，完成后自动出现在列表里。' });
      setInput('');
      setTimeout(onClose, 1400);
    } finally {
      setBusy(false);
    }
  };

  const badgeOf = (p) => {
    if (!p.needsLogin) return { text: '免登录', cls: '' };
    return p.loggedIn ? { text: '已登录', cls: ' ok' } : { text: '未登录', cls: ' warn' };
  };

  return (
    <Modal
      open={open}
      title="添加订阅"
      width={560}
      onCancel={onClose}
      onOk={doAdd}
      okText="识别并订阅"
      cancelText="取消"
      okButtonProps={{ loading: busy }}
      destroyOnClose
    >
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>选择平台</div>
        <div className="tiles">
          <div className={'tile' + (platformId == null ? ' on' : '')} onClick={() => pickPlatform(null)}>
            <span className="dot" style={{ background: '#35c4b5' }} />
            <span className="tile-name">自动识别</span>
            <span className="tile-badge">按输入判断</span>
          </div>
          {platforms.map((p) => {
            const badge = badgeOf(p);
            return (
              <div key={p.id} className={'tile' + (platformId === p.id ? ' on' : '')} onClick={() => pickPlatform(p.id)}>
                <span className="dot" style={{ background: p.color || '#6b7280' }} />
                <span className="tile-name">{p.name}</span>
                <span className={'tile-badge' + badge.cls}>{badge.text}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>主页地址 / 用户 id</div>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            size="large"
            value={input}
            placeholder="粘贴链接或填 id"
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={doAdd}
          />
          <Button size="large" icon={<SnippetsOutlined />} onClick={paste}>粘贴</Button>
        </Space.Compact>
        <div style={{ fontSize: 12, opacity: 0.5, marginTop: 4 }}>{inputHint}</div>
      </div>

      {platform ? (
        <div style={{ marginBottom: 14 }}>
          <Button block icon={<TeamOutlined />} onClick={() => onOpenFollowings(platform)}>
            从我的关注里选
          </Button>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>订阅哪些内容</div>
          {platform ? (
            <div className="chips">
              {(platform.contentTypes || []).map((k) => (
                <Tag.CheckableTag key={k} checked={kinds.includes(k)} onChange={() => toggleKind(k)}>{k}</Tag.CheckableTag>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.5 }}>
              自动识别平台后，将自动订阅该平台的全部内容形式
            </div>
          )}
        </div>
        {platform && !platform.builtin ? (
          <div style={{ width: 160 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>回看历史</div>
            <Select value={range} onChange={setRange} style={{ width: '100%' }}
              options={RANGE_OPTIONS.map((r) => ({ value: r, label: '近 ' + r }))} />
            <div style={{ fontSize: 12, opacity: 0.5, marginTop: 4 }}>只影响首次回溯</div>
          </div>
        ) : null}
      </div>

      {result ? (
        <Alert
          style={{ marginTop: 14 }}
          type={result.type}
          showIcon
          message={result.title}
          description={result.body}
        />
      ) : null}
    </Modal>
  );
}
