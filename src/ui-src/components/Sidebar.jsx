import React, { useState } from 'react';
import { Button, Dropdown } from 'antd';
import {
  PlusOutlined, ReloadOutlined, SettingOutlined,
  MoreOutlined, UserOutlined, DeleteOutlined, DownOutlined, RightOutlined,
} from '@ant-design/icons';

/** 头像：有图显示图（加载失败回退首字母）。 */
export function FAvatar({ src, name, size = 30 }) {
  const [broken, setBroken] = useState(false);
  const letter = (name || '?').slice(0, 1);
  if (!src || broken) {
    return <span className="avatar letter" style={{ width: size, height: size }}>{letter}</span>;
  }
  return (
    <img
      className="avatar" style={{ width: size, height: size }}
      src={src} alt="" loading="lazy" onError={() => setBroken(true)}
    />
  );
}

function Group({ platform, active, count, expanded, onToggle, children, onSelect, onLogin, onConfig, onRemove }) {
  const name = platform ? platform.name : '全部';
  const color = platform ? (platform.color || '#6b7280') : '#35c4b5';
  return (
    <div className={'group' + (active ? ' active' : '')}>
      <div className="group-head" onClick={onSelect} title={name}>
        <button className="chev" title={expanded ? '收起' : '展开'} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          {expanded ? <DownOutlined /> : <RightOutlined />}
        </button>
        <span className="group-dot" style={{ background: color }} />
        <span className="group-name">{name}</span>
        {platform && platform.needsLogin ? (
          <span className={'login-badge ' + (platform.loggedIn ? 'ok' : 'warn')}>
            {platform.loggedIn ? '已登录' : '未登录'}
          </span>
        ) : null}
        <span className="group-count">{count}</span>
        {platform ? (
          <span className="group-tools" onClick={(e) => e.stopPropagation()}>
            {platform.needsLogin ? (
              <Button size="small" type="text" onClick={() => onLogin(platform.id)}>登录</Button>
            ) : null}
            <Button size="small" type="text" onClick={() => onConfig(platform.id)}>配置</Button>
            {!platform.builtin ? (
              <Button size="small" type="text" danger onClick={() => onRemove(platform)}>删除</Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {expanded ? children : null}
    </div>
  );
}

function SourceRow({ source, active, unread, onClick, onSync, onEdit, onRemove }) {
  const sub = source.lastError
    ? '⚠ ' + source.lastError
    : unread
      ? `${unread} 条未读`
      : source.enabled === false ? '已停用' : (source.sign || '已同步');
  const menu = {
    items: [
      { key: 'sync', icon: <ReloadOutlined />, label: '立即检查更新' },
      { key: 'settings', icon: <UserOutlined />, label: '订阅设置' },
      { type: 'divider' },
      { key: 'remove', icon: <DeleteOutlined />, label: '取消订阅', danger: true },
    ],
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation();
      if (key === 'sync') onSync(source.id);
      else if (key === 'settings') onEdit(source);
      else if (key === 'remove') onRemove(source);
    },
  };
  return (
    <div
      className={'source' + (active ? ' active' : '') + (source.lastError ? ' warn' : '')}
      title={source.lastError || source.sign || source.name}
      onClick={onClick}
    >
      <FAvatar src={source.avatarFile || source.avatar} name={source.name} />
      <div className="source-info">
        <div className="source-name">{source.name}</div>
        <div className="source-sub">{sub}</div>
      </div>
      <Dropdown menu={menu} trigger={['click']}>
        <Button
          size="small" type="text" icon={<MoreOutlined />}
          onClick={(e) => e.stopPropagation()}
        />
      </Dropdown>
    </div>
  );
}

export default function Sidebar(props) {
  const { platforms, sources, posts, read, listId, sourceId, syncHint, syncRunning } = props;
  const countOf = (id) => sources.filter((s) => id === 'all' || s.platformId === id).length;
  const sourcesOf = (id) => sources.filter((s) => id === 'all' || s.platformId === id);
  const unreadOf = (sid) => posts.filter((p) => p.sourceId === sid && !read.has(p.id)).length;

  /* 分组展开/收起：默认「全部」展开、平台组收起，状态记在 localStorage。 */
  const [expandedMap, setExpandedMap] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sidebarExpanded')) || {}; } catch { return {}; }
  });
  const isExpanded = (id) => expandedMap[id] ?? (id === 'all');
  const setExpanded = (id, value) => {
    setExpandedMap((prev) => {
      const next = { ...prev, [id]: value };
      localStorage.setItem('sidebarExpanded', JSON.stringify(next));
      return next;
    });
  };
  const selectList = (id) => {
    setExpanded(id, true); // 选中某个列表时自动展开它的分组
    props.onSelectList(id);
  };

  const renderSources = (id) => {
    const list = sourcesOf(id);
    if (!list.length) {
      return (
        <div className="sources">
          <div className="empty-note">
            {id === 'all' ? '还没有订阅，点上方「＋ 订阅」' : '这个列表还是空的'}
          </div>
        </div>
      );
    }
    return (
      <div className="sources">
        {list.map((s) => (
          <SourceRow
            key={s.id}
            source={s}
            active={sourceId === s.id}
            unread={unreadOf(s.id)}
            onClick={() => props.onSelectSource(s.id)}
            onSync={props.onSyncSource}
            onEdit={props.onEditSource}
            onRemove={props.onRemoveSource}
          />
        ))}
      </div>
    );
  };

  const groupProps = (id, platform) => ({
    platform,
    active: listId === id,
    count: countOf(id),
    expanded: isExpanded(id),
    onToggle: () => setExpanded(id, !isExpanded(id)),
    onSelect: () => selectList(id),
    onLogin: props.onLogin,
    onConfig: props.onConfigPlatform,
    onRemove: props.onRemovePlatform,
  });

  return (
    <aside className="sidebar">
      <div className="pane-head">
        <h2>订阅列表</h2>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={props.onOpenAdd}>
          订阅
        </Button>
      </div>
      <nav className="groups">
        <Group {...groupProps('all', null)}>
          {renderSources('all')}
        </Group>
        {platforms.map((p) => (
          <Group key={p.id} {...groupProps(p.id, p)}>
            {renderSources(p.id)}
          </Group>
        ))}
      </nav>
      <div className="sidebar-footer">
        <span className="sync-hint">{syncHint}</span>
        <div className="sidebar-bottom-row">
          <Button size="small" type="primary" icon={<ReloadOutlined />}
            loading={syncRunning} onClick={props.onSync}>
            刷新
          </Button>
          <Button size="small" icon={<SettingOutlined />} onClick={props.onOpenSettings}>
            设置
          </Button>
        </div>
      </div>
    </aside>
  );
}
