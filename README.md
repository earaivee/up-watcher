# up-watcher（你快更新啊）

订阅 B站 / 抖音的 UP 主与博主，定时检查更新并弹通知。历史记录只增不删——对方删掉的内容，本地仍保留标题、正文和封面快照。

![B站](docs/screenshot-bilibili.png)

![抖音](docs/screenshot-douyin.png)

## 功能

- 定时检查订阅更新，浮窗 / Windows 通知提醒，点击直达原文
- 添加订阅时按回看范围回溯历史，改大范围自动补抓
- 图墙 / 列表两种视图，图墙按平台自动适配比例（B站 16:9、抖音 9:16）
- 登录后可从关注列表搜索、多选、批量订阅
- 封面与头像存档到本地，原图失效也能看
- 除 B站 / 抖音外可添加自定义平台
- 数据全部存在 exe 同级的 `up-watcher-data/`，绿色便携

## 运行

```powershell
npm install   # 需要 Node 22
npm start     # 构建界面并启动
npm run dist  # 打包 exe
```

高级配置直接改 `up-watcher-data/_global/platforms.json`（支持注释，字段说明见同目录的 配置说明.txt）。