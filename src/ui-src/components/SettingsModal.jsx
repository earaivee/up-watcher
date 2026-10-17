import React, { useEffect, useState } from 'react';
import { Button, Form, InputNumber, Modal, Select } from 'antd';
import { FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import { api, RANGE_OPTIONS } from '../api.js';

/**
 * 设置弹窗：回看范围 / 刷新间隔 / 增量上限 / 通知方式，
 * 登录状态列表（可实时检查），自定义平台入口，数据目录。
 */
export default function SettingsModal(props) {
  const { open, settings, platforms, dataRoot } = props;
  const [form] = Form.useForm();
  const [checking, setChecking] = useState({});

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      range: settings.range || '15天',
      intervalMinutes: settings.intervalMinutes ?? 20,
      incrementalLimit: settings.incrementalLimit ?? 12,
      notifyMode: settings.notifyMode || 'toast',
      notifyLimit: settings.notifyLimit ?? 3,
    });
  }, [open, settings, form]);

  const onOk = async () => {
    const values = await form.validateFields();
    props.onSave({
      range: values.range || '15天',
      intervalMinutes: Math.max(5, Number(values.intervalMinutes) || 20),
      incrementalLimit: Math.max(1, Number(values.incrementalLimit) || 12),
      notifyMode: values.notifyMode,
      notifyLimit: Math.max(1, Number(values.notifyLimit) || 3),
    });
  };

  const check = async (p) => {
    setChecking((c) => ({ ...c, [p.id]: true }));
    try {
      await props.onCheckLogin(p.id, p.name);
      await props.onRefreshPlatforms();
    } finally {
      setChecking((c) => ({ ...c, [p.id]: false }));
    }
  };

  const needLogin = platforms.filter((p) => p.needsLogin);

  return (
    <Modal
      open={open}
      title="设置"
      width={520}
      onCancel={props.onClose}
      onOk={onOk}
      okText="保存"
      cancelText="关闭"
    >
      <Form form={form} layout="vertical">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 16 }}>
          <Form.Item name="range" label="回看历史" style={{ marginBottom: 12 }}
            extra="添加订阅时按它回溯一次">
            <Select options={[
              ...RANGE_OPTIONS.map((r) => ({ value: r, label: '近 ' + r })),
            ]} />
          </Form.Item>
          <Form.Item name="intervalMinutes" label="检查间隔（分钟）" style={{ marginBottom: 12 }}
            extra="太频繁容易被平台限流，建议 ≥ 20">
            <InputNumber min={5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="incrementalLimit" label="每轮最多抓几条" style={{ marginBottom: 12 }}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="notifyLimit" label="一次最多弹几条" style={{ marginBottom: 12 }}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <Form.Item name="notifyMode" label="更新提醒方式" style={{ marginBottom: 12 }}>
          <Select options={[
            { value: 'toast', label: '右下角浮窗（带大图）' },
            { value: 'native', label: 'Windows 通知' },
            { value: 'both', label: '两者都要' },
          ]} />
        </Form.Item>

        <Form.Item label="登录状态" style={{ marginBottom: 12 }}
          extra="点「检查」会实时校验登录态是否还有效（B站精确校验；抖音只能确认凭证是否还在，最终以抓取结果为准）">
          {needLogin.length === 0 ? (
            <span style={{ fontSize: 12, opacity: 0.5 }}>没有需要登录的平台</span>
          ) : needLogin.map((p) => (
            <div className="login-state-row" key={p.id}>
              <span className="group-dot" style={{ background: p.color || '#6b7280' }} />
              <span className="ls-name">{p.name}</span>
              <span className={'ls-status ' + (p.loggedIn ? 'ok' : 'warn')}>
                {p.loggedIn ? '已登录' : '未登录'}
              </span>
              <Button size="small" loading={!!checking[p.id]} onClick={() => check(p)}>检查</Button>
            </div>
          ))}
        </Form.Item>

        <Form.Item label="自定义平台" style={{ marginBottom: 12 }}
          extra="内置平台之外的站点可以自己加一个；保存后可在侧栏该平台分组里改名称、颜色，删除自定义平台也在侧栏分组里">
          <Button icon={<PlusOutlined />} onClick={props.onNewPlatform}>＋ 新增平台</Button>
        </Form.Item>

        <Form.Item label="数据目录" style={{ marginBottom: 0 }}
          extra="所有数据（订阅、历史、登录态、媒体快照）都存在这里，跟程序走">
          <div className="data-dir-row">
            <span className="path" title={dataRoot}>{dataRoot}</span>
            <Button size="small" icon={<FolderOpenOutlined />}
              onClick={() => api.data.reveal()} title="在资源管理器中打开数据目录">
              打开
            </Button>
          </div>
        </Form.Item>
      </Form>
    </Modal>
  );
}
