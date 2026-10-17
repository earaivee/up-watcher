import React, { useEffect } from 'react';
import { Button, Form, Modal, Select, Switch } from 'antd';
import { RANGE_OPTIONS } from '../api.js';
import { FAvatar } from './Sidebar.jsx';

/** 订阅设置：回看范围 / 启用开关 / 当前头像与历史头像入口。 */
export default function SourceModal({ open, source, onClose, onSave }) {
  const [form] = Form.useForm();

  useEffect(() => {
    if (!open || !source) return;
    form.setFieldsValue({ range: source.range || '', enabled: source.enabled !== false });
  }, [open, source, form]);

  if (!source) return null;

  return (
    <Modal
      open={open}
      title={`订阅设置 · ${source.name}`}
      width={460}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
      onOk={async () => {
        const values = await form.validateFields();
        onSave({ id: source.id, range: values.range || null, enabled: values.enabled });
      }}
    >
      <div className="source-head">
        <FAvatar src={source.avatarFile || source.avatar} name={source.name} size={44} />
      </div>
      <Form form={form} layout="vertical">
        <Form.Item name="range" label="回看范围">
          <Select
            options={[
              { value: '', label: '跟随全局' },
              ...RANGE_OPTIONS.map((r) => ({ value: r, label: '近 ' + r })),
            ]}
          />
        </Form.Item>
        <Form.Item name="enabled" label="启用这个订阅" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}
