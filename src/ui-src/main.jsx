import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme as antdTheme, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App.jsx';
import { bindMessage } from './message.js';
import './global.css';

function Root() {
  const { message, modal } = AntdApp.useApp();
  useEffect(() => { bindMessage(message); }, [message]);
  return <App modal={modal} />;
}

createRoot(document.getElementById('root')).render(
  <ConfigProvider
    locale={zhCN}
    theme={{
      algorithm: antdTheme.darkAlgorithm,
      token: { colorPrimary: '#35c4b5', borderRadius: 8, colorBgBase: '#14161a' },
    }}
  >
    <AntdApp>
      <Root />
    </AntdApp>
  </ConfigProvider>,
);
