import React, { useEffect, useState } from 'react';
import { Button, ColorPicker, Form, Input, Modal, Tag, Typography } from 'antd';
import { api } from '../api.js';
import { toast } from '../message.js';

/**
 * 平台配置：只编辑展示层字段（名称 / 颜色 / 标识 / 内容形式）。
 * 抓取接口、字段映射、登录等高级配置不走界面，直接改数据目录的
 * _global\platforms.json（支持 // 注释，字段说明见 _global\配置说明.txt）。
 * 保存时从 editingDef 原样带上其余字段。
 */
export default function PlatformModal({ open, platformId, modal, onClose, onSaved, onRemoved }) {
  const [def, setDef] = useState(null);       // 正在编辑的完整配置（表单之外的字段原样保留）
  const [types, setTypes] = useState([]);     // 内容形式行：[{ name, url }]
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6b7280');
  const [idText, setIdText] = useState('');
  const [typeInput, setTypeInput] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDef(null);
    setTypes([]);
    setTypeInput('');
    (async () => {
      const res = platformId ? await api.platforms.get(platformId) : await api.platforms.template();
      if (!res.ok) { toast(res.error, 'err'); onClose(); return; }
      const d = JSON.parse(JSON.stringify(res.data));
      if (!platformId) d.name = ''; // 新平台不预填示例值
      setDef(d);
      setName(d.name || '');
      setColor(d.color || '#6b7280');
      setIdText(d.id || '');
      setTypes((d.types?.length ? d.types : (d.contentTypes || ['视频']).map((n) => ({ name: n })))
        .map((t) => ({ name: t.name || '', url: t.url || '' })));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, platformId]);

  const addType = () => {
    const text = typeInput.trim();
    if (!text) return;
    if (types.some((t) => t.name === text)) return toast('已有同名的内容形式', 'err');
    setTypes((prev) => [...prev, { name: text, url: '' }]);
    setTypeInput('');
  };

  const buildDef = () => {
    const next = JSON.parse(JSON.stringify(def || {}));
    next.id = idText.trim() || next.id || '';
    next.name = name.trim();
    if (color) next.color = color;
    const rows = types.map((t) => ({ name: t.name.trim(), url: (t.url || '').trim() })).filter((t) => t.name);
    next.contentTypes = rows.map((t) => t.name);
    if (rows.some((t) => t.url)) {
      next.types = rows.map((t) => (t.url ? { name: t.name, url: t.url } : { name: t.name }));
    } else {
      delete next.types; // 全部共用列表接口时不需要存 types
    }
    return next;
  };

  const validate = (next) => {
    if (!next.id) return '标识不能为空';
    if (!platformId && !/^[a-z][\w-]*$/i.test(next.id)) return '标识请用英文/数字（例如 mysite）';
    if (!next.name) return '名称不能为空';
    if (!next.contentTypes.length) return '至少要有一个内容形式';
    return null;
  };

  const save = async () => {
    const next = buildDef();
    const error = validate(next);
    if (error) return toast(error, 'err');
    setBusy(true);
    try {
      const res = await api.platforms.save(next);
      if (!res.ok) return toast(res.error, 'err');
      onClose();
      await onSaved(); // 新增/改名后侧栏分组要跟着变
      toast('平台配置已保存', 'ok');
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    modal.confirm({
      title: '删除自定义平台',
      content: `删除「${name || idText}」？它下面的订阅也会一起移除。`,
      okButtonProps: { danger: true },
      okText: '删除',
      cancelText: '取消',
      onOk: async () => {
        const res = await api.platforms.remove(platformId);
        if (!res.ok) return toast(res.error, 'err');
        onClose();
        await onRemoved(); // 分组没了要退回「全部」，订阅也一并清了
        toast('平台已删除', 'ok');
      },
    });
  };

  return (
    <Modal
      open={open}
      width={620}
      title={platformId ? `平台配置 · ${(def && (def.name || def.id)) || ''}` : '新增自定义平台'}
      onCancel={onClose}
      footer={[
        platformId && def && !def.builtin ? (
          <Button key="remove" danger onClick={remove}>删除该平台</Button>
        ) : null,
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="save" type="primary" loading={busy} onClick={save}>保存</Button>,
      ]}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        这里只管<strong>名称、颜色、内容形式</strong>。抓取接口、字段映射、登录等高级配置直接改数据目录下的配置文件：
        <Typography.Text code>_global\platforms.json</Typography.Text>
        （支持 // 注释），改完重启生效；每个字段是什么意思见 <Typography.Text code>_global\配置说明.txt</Typography.Text>。
      </Typography.Paragraph>

      <Form layout="vertical">
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item label="名称" style={{ flex: 1, marginBottom: 12 }}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：某站点" />
          </Form.Item>
          <Form.Item label="颜色" style={{ marginBottom: 12 }}>
            <ColorPicker value={color} onChange={(c) => setColor(c.toHexString())} showText />
          </Form.Item>
        </div>
        <Form.Item label="标识" style={{ marginBottom: 12 }}
          extra={platformId ? '已有平台不可改' : '保存后不可改'}>
          <Input value={idText} disabled={!!platformId} placeholder="英文/数字，如 mysite"
            onChange={(e) => setIdText(e.target.value)} />
        </Form.Item>
        <Form.Item label="内容形式" style={{ marginBottom: 0 }}
          extra="标签就是内容的分类（视频 / 图文…）。带 🔗 的形式配了单独抓取地址，在 _global\platforms.json 里改">
          <div className="type-tags">
            {types.map((t, i) => (
              <Tag
                key={`${t.name}-${i}`}
                closable
                onClose={() => setTypes((prev) => prev.filter((_, idx) => idx !== i))}
                title={t.url ? `单独抓取地址：${t.url}` : ''}
                color={t.url ? 'cyan' : undefined}
              >
                {t.name || '（未命名）'}{t.url ? ' 🔗' : ''}
              </Tag>
            ))}
          </div>
          <Input
            style={{ marginTop: 8 }}
            value={typeInput}
            placeholder="输入名称按回车添加，如：视频"
            onChange={(e) => setTypeInput(e.target.value)}
            onPressEnter={(e) => { e.preventDefault(); addType(); }}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
