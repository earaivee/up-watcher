import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, POST_LIMIT } from './api.js';
import { toast } from './message.js';
import Sidebar from './components/Sidebar.jsx';
import Feed, { visiblePostsOf } from './components/Feed.jsx';
import Detail from './components/Detail.jsx';

/** 界面偏好（每页条数），存 localStorage 跟着用户走。宽高比和列数都读平台配置。 */
const UI_PREF_DEFAULTS = { pageSize: 10 };
const PAGE_SIZE_CHOICES = [10, 25, 50];
const UI_PREFS_VERSION = 2; // 结构升级时 +1：旧存档整批作废，避免陈旧偏好顶掉新默认值
import AddModal from './components/AddModal.jsx';
import FollowingsModal from './components/FollowingsModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import PlatformModal from './components/PlatformModal.jsx';
import SourceModal from './components/SourceModal.jsx';

/**
 * 全局状态 + 三栏布局 + 弹窗调度。
 * 内容一次拉全（上限 3000 条，按发布时间倒序），筛选全部在本地做。
 */
export default function App({ modal }) {
  const [settings, setSettings] = useState({});
  const [platforms, setPlatforms] = useState([]);
  const [sources, setSources] = useState([]);
  const [posts, setPosts] = useState([]);
  const [dataRoot, setDataRoot] = useState('');
  const [listId, setListId] = useState('all');       // 左侧分组：'all' 或平台 id
  const [sourceId, setSourceId] = useState(null);
  const [kind, setKind] = useState(null);
  const [activePostId, setActivePostId] = useState(null);
  const [feedView, setFeedView] = useState('grid');
  const [feedPage, setFeedPage] = useState(1);
  const [uiPrefs, setUiPrefs] = useState(() => {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem('uiPrefs') || '{}') || {};
      if (saved.v !== UI_PREFS_VERSION) saved = { v: UI_PREFS_VERSION }; // 旧版本存档作废
    } catch { saved = { v: UI_PREFS_VERSION }; }
    return { ...UI_PREF_DEFAULTS, ...saved };
  });
  const [syncRunning, setSyncRunning] = useState(false);
  const [lastSyncDone, setLastSyncDone] = useState(null);
  const [read, setRead] = useState(() => new Set(JSON.parse(localStorage.getItem('read') || '[]')));
  const [nowTick, setNowTick] = useState(Date.now());           // 每秒一跳，驱动倒计时
  const [modalOpen, setModalOpen] = useState(null);             // 'add' | 'settings' | 'platform' | 'source'
  const [editingPlatformId, setEditingPlatformId] = useState(null); // null = 新增
  const [editingSource, setEditingSource] = useState(null);
  const [followPlatform, setFollowPlatform] = useState(null);   // 关注列表弹窗当前的平台
  const [loginTick, setLoginTick] = useState(0);                // 登录事件发生次数（驱动弹窗联动）

  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  /* ---------------- 数据拉取 ---------------- */

  const refreshPlatforms = useCallback(async () => {
    const res = await api.platforms.list();
    if (!res.ok) return;
    setPlatforms(res.data);
  }, []);

  const refreshAll = useCallback(async () => {
    const [sourcesRes, postsRes] = await Promise.all([api.sources.list(), api.posts.list({ limit: POST_LIMIT })]);
    if (sourcesRes.ok) setSources(sourcesRes.data);
    if (postsRes.ok) setPosts(postsRes.data.items);
  }, []);

  /* 节流刷新：补抓时每页都会来一次 source:updated，全量重拉列表太浪费，
     1.5 秒内的多次事件合并成一次（最后一次事件后必然刷新）。 */
  const refreshTimer = useRef(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(async () => {
      refreshTimer.current = null;
      await refreshAll();
    }, 1500);
  }, [refreshAll]);
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  /* ---------------- 启动 + 主进程事件 ---------------- */

  useEffect(() => {
    (async () => {
      const res = await api.bootstrap();
      if (!res.ok) return toast('启动失败：' + res.error, 'err');
      setSettings(res.data.settings);
      setPlatforms(res.data.platforms);
      setSources(res.data.sources);
      setDataRoot(res.data.dataRoot);
      setSyncRunning(!!res.data.running);
      // 版本号放在窗口标题栏（exe 最顶部）：「你快更新啊 v0.2.0」
      if (res.data.version) document.title = `你快更新啊 v${res.data.version}`;
      await refreshAll();
    })();
    return api.onEvent(({ name, data }) => onEvent(name, data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onEvent = (name, data) => {
    switch (name) {
      case 'source:added':
      case 'source:updated':
      case 'source:removed':
        scheduleRefresh(); // 补抓每批入库都会触发，节流合并
        break;
      case 'collect:done':
        scheduleRefresh();
        if (data.needLogin) toast(data.needLogin, 'err');
        else if (data.notice) toast(data.notice, 'err');
        else if (data.added) toast(`已补齐 ${data.added} 条历史`, 'ok');
        break;
      case 'collect:failed':
        toast('回溯失败：' + data.message, 'err');
        scheduleRefresh();
        break;
      case 'sync:start':
        setSyncRunning(true);
        break;
      case 'sync:done': {
        setSyncRunning(false);
        const text = data.added ? `本轮新增 ${data.added} 条` : '本轮没有更新';
        setLastSyncDone({ at: Date.now(), text });
        for (const fail of data.failures || []) {
          const source = sourcesRef.current.find((s) => s.id === fail.sourceId);
          toast(`${source ? source.name : '订阅'}：${fail.message}`, 'err');
        }
        refreshAll();
        break;
      }
      case 'platforms:changed':
        refreshPlatforms();
        break;
      case 'login:changed':
        refreshPlatforms();
        if (data && data.ok) toast(`已登录${data.name ? '：' + data.name : ''}`, 'ok');
        else if (data && data.closed) toast('登录窗口已关闭');
        setLoginTick((t) => t + 1);
        break;
      case 'settings:changed':
        setSettings(data);
        break;
      case 'app:crash':
        toast(`${data.message} ${data.url}`, 'err');
        break;
      default: break;
    }
  };

  /* 每秒一跳：驱动「距下次刷新」倒计时。 */
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const syncHint = (() => {
    if (syncRunning) return '正在检查订阅…';
    const done = lastSyncDone;
    if (done && nowTick - done.at < 6000) return done.text;
    // 按所有启用订阅里最早到期的那个算
    const enabled = sources.filter((s) => s.enabled !== false);
    if (!enabled.length) return '没有启用中的订阅';
    const interval = Math.max(5, settings?.intervalMinutes ?? 20) * 60000;
    let next = Infinity;
    for (const s of enabled) next = Math.min(next, (s.lastSyncAt || 0) + interval);
    const remain = next - nowTick;
    if (remain <= 0) return '即将刷新…';
    const min = Math.floor(remain / 60000);
    const sec = Math.floor((remain % 60000) / 1000);
    return min > 0 ? `距下次刷新 ${min} 分 ${String(sec).padStart(2, '0')} 秒` : `距下次刷新 ${sec} 秒`;
  })();

  /* ---------------- 选择 / 已读 ---------------- */

  const selectList = (id) => {
    setListId(id); setSourceId(null); setKind(null); setActivePostId(null); setFeedPage(1);
  };
  const selectSource = (id) => {
    if (sourceId === id) return;
    setSourceId(id); setKind(null); setActivePostId(null); setFeedPage(1);
  };
  const selectKind = (k) => { setKind(k); setFeedPage(1); };
  const updatePrefs = (patch) => {
    setUiPrefs((prev) => {
      const next = { ...UI_PREF_DEFAULTS, ...prev, ...patch, v: UI_PREFS_VERSION };
      localStorage.setItem('uiPrefs', JSON.stringify(next));
      return next;
    });
  };
  const markRead = (id) => {
    setRead((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem('read', JSON.stringify([...next].slice(-4000)));
      return next;
    });
  };
  const openPost = (post) => {
    markRead(post.id);
    setActivePostId(post.id);
  };

  /** 把当前筛选下可见的内容全部标为已读（不影响其它分组/类型）。 */
  const markAllRead = () => {
    const visible = visiblePostsOf({ posts, sourceId, listId, kind });
    if (!visible.length) return;
    setRead((prev) => {
      const next = new Set(prev);
      for (const p of visible) next.add(p.id);
      localStorage.setItem('read', JSON.stringify([...next].slice(-4000)));
      return next;
    });
    toast('已将当前列表全部标为已读', 'ok');
  };

  /* ---------------- 动作 ---------------- */

  const doLogin = async (platformId) => {
    const res = await api.sources.login(platformId);
    toast(res.ok ? (res.data.message || '登录窗口已打开') : res.error, res.ok ? 'ok' : 'err');
  };

  const syncSource = async (id) => {
    toast('开始检查这个订阅…');
    const res = await api.sources.sync(id);
    if (!res.ok) toast(res.error, 'err');
  };

  const onSyncClick = async () => {
    const res = await api.syncNow();
    if (!res.ok) toast(res.error, 'err'); // 成功时由 sync:done 事件恢复按钮
  };

  const confirmRemoveSource = (source) => {
    if (!source) return;
    modal.confirm({
      title: '取消订阅',
      content: `确定取消订阅「${source.name}」？已抓到的历史会保留在本地。`,
      okButtonProps: { danger: true },
      okText: '取消订阅',
      cancelText: '再想想',
      onOk: async () => {
        const res = await api.sources.remove(source.id);
        setModalOpen(null);
        if (!res.ok) return toast(res.error, 'err');
        if (sourceId === source.id) setSourceId(null);
        await refreshAll();
      },
    });
  };

  const openLink = async (post) => {
    const source = sources.find((s) => s.id === post.sourceId);
    const url = post.link || (source && source.homeUrl) || '';
    if (!url) return toast('这条内容没有可打开的链接', 'err');
    try {
      const res = await api.links.open(url);
      const mode = res && res.ok && res.data ? res.data.mode : '';
      if (mode === 'viewer') toast('已在内置浏览器打开', 'ok');
      else if (mode === 'external') toast('已交给系统浏览器打开');
    } catch (err) {
      toast('打开失败：' + (err.message || '未知原因'), 'err');
    }
  };

  /** 给没有封面的旧内容手动补快照：截图 → 存档 → 刷新（按钮自动从「截取」切成「查看」）。 */
  const snapshotCover = async (post) => {
    toast('正在打开原文页面并截图，约需 10 秒…');
    const res = await api.posts.snapshot({ id: post.id, link: post.link });
    if (res.ok) {
      toast('动态快照已保存', 'ok');
      await refreshAll();
    } else {
      toast(res.error || '截图失败', 'err');
    }
  };

  const saveSettings = async (patch) => {
    const res = await api.settings.save(patch);
    if (!res.ok) return toast(res.error, 'err');
    setSettings(res.data);
    setModalOpen(null);
    toast('设置已保存', 'ok');
  };

  /* ---------------- 弹窗调度 ---------------- */

  const openPlatformModal = (id) => { setEditingPlatformId(id ?? null); setModalOpen('platform'); };
  const openSourceModal = (source) => { setEditingSource(source); setModalOpen('source'); };

  const activePost = posts.find((p) => p.id === activePostId) || null;

  return (
    <div className="layout">
      <Sidebar
        platforms={platforms}
        sources={sources}
        posts={posts}
        read={read}
        listId={listId}
        sourceId={sourceId}
        syncHint={syncHint}
        syncRunning={syncRunning}
        onSelectList={selectList}
        onSelectSource={selectSource}
        onSync={onSyncClick}
        onOpenSettings={() => setModalOpen('settings')}
        onOpenAdd={() => setModalOpen('add')}
        onLogin={doLogin}
        onConfigPlatform={openPlatformModal}
        onRemovePlatform={openPlatformModalRemove(modal, refreshPlatforms, refreshAll)}
        onSyncSource={syncSource}
        onEditSource={openSourceModal}
        onRemoveSource={confirmRemoveSource}
      />
      <Feed
        posts={posts}
        sources={sources}
        platforms={platforms}
        listId={listId}
        sourceId={sourceId}
        kind={kind}
        activePostId={activePostId}
        read={read}
        feedView={feedView}
        page={feedPage}
        pageSize={uiPrefs.pageSize}
        prefs={uiPrefs}
        onKind={selectKind}
        onFeedView={setFeedView}
        onOpenPost={openPost}
        onMarkAllRead={markAllRead}
        onPage={setFeedPage}
        onPrefs={updatePrefs}
      />
      <Detail
        post={activePost}
        sources={sources}
        dataRoot={dataRoot}
        onOpenLink={openLink}
        onSnapshot={snapshotCover}
      />

      <AddModal
        open={modalOpen === 'add'}
        settings={settings}
        platforms={platforms}
        onClose={() => setModalOpen(null)}
        onOpenFollowings={(p) => { setFollowPlatform(p); setModalOpen('followings'); }}
      />
      <FollowingsModal
        open={modalOpen === 'followings'}
        platform={followPlatform ? platforms.find((p) => p.id === followPlatform.id) || followPlatform : null}
        sources={sources}
        loginTick={loginTick}
        onClose={() => setModalOpen(null)}
        onRefresh={refreshAll}
        onLogin={doLogin}
      />
      <SettingsModal
        open={modalOpen === 'settings'}
        settings={settings}
        platforms={platforms}
        dataRoot={dataRoot}
        onClose={() => setModalOpen(null)}
        onSave={saveSettings}
        onNewPlatform={() => { setModalOpen(null); openPlatformModal(null); }}
        onCheckLogin={checkLogin}
        onRefreshPlatforms={refreshPlatforms}
        onLogin={doLogin}
      />
      <PlatformModal
        open={modalOpen === 'platform'}
        platformId={editingPlatformId}
        modal={modal}
        onClose={() => setModalOpen(null)}
        onSaved={refreshPlatforms}
        onRemoved={async () => { await refreshPlatforms(); await refreshAll(); }}
      />
      <SourceModal
        open={modalOpen === 'source'}
        source={editingSource}
        onClose={() => setModalOpen(null)}
        onSave={async (patch) => {
          const res = await api.sources.update(patch);
          if (!res.ok) return toast(res.error, 'err');
          setModalOpen(null);
          await refreshAll();
          toast('订阅设置已保存', 'ok');
        }}
      />
    </div>
  );
}

/** 设置弹窗里的「检查登录态」：实时校验是否失效。 */
async function checkLogin(platformId, name) {
  toast(`正在检查 ${name} 登录状态…`);
  const res = await api.sources.loginState(platformId);
  if (res.ok && res.data && res.data.ok) {
    toast(`${name}：登录有效${res.data.name ? `（${res.data.name}）` : ''}`, 'ok');
  } else {
    toast(`${name}：${(res.data && res.data.message) || res.error || '登录已失效，请重新登录'}`, 'err');
  }
}

/** 删除自定义平台（内置平台后端会拒绝）。 */
function openPlatformModalRemove(modal, refreshPlatforms, refreshAll) {
  return (platform) => {
    if (!platform) return;
    modal.confirm({
      title: '删除自定义平台',
      content: `删除「${platform.name}」？它下面的订阅也会一起移除。`,
      okButtonProps: { danger: true },
      okText: '删除',
      cancelText: '取消',
      onOk: async () => {
        const res = await api.platforms.remove(platform.id);
        if (!res.ok) return toast(res.error, 'err');
        await refreshPlatforms(); // 分组没了要退回「全部」
        await refreshAll();       // 该平台下的订阅也被清了
        toast('平台已删除', 'ok');
      },
    });
  };
}
