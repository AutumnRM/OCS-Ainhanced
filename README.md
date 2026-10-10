# OCS-Ainhanced

OCS-Ainhanced 是基于 [ocsjs](https://github.com/ocsjs/ocsjs) 的个人增强版，包含 AI 答题和桌面端稳定性改进。它面向学习辅助和本地开发，不代表 OCS 官方项目。

## 版本

- 用户脚本：4.15.7
- Windows 桌面端：2.12.11

## AI 答题

增强脚本将 AI 作为唯一答案来源，不会查询传统题库或保存答案缓存。AI 答题需要启动桌面端，并在客户端填写 Responses API 地址、模型 ID 和 API Key。客户端使用 Electron `safeStorage` 加密保存 API Key；系统不支持安全存储时会拒绝保存。

配置、迁移、故障诊断及 MOOC 播放控制说明见 [`docs/AI_ANSWERS.md`](docs/AI_ANSWERS.md)。

## 构建

根目录脚本使用 pnpm：

```bash
pnpm install
pnpm build
pnpm test
```

桌面端位于 `ocs-desktop/`，其开发和构建说明见 [`ocs-desktop/README.md`](ocs-desktop/README.md)。

## 来源与许可

脚本基于 ocsjs，按仓库中的 MIT License 发布。桌面端来自 [ocs-desktop](https://github.com/ocsjs/ocs-desktop)；其各 workspace package 的 `package.json` 声明 MIT 许可。来源、归属和许可信息见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

本项目与 ocsjs 官方项目及课程平台无隶属关系。使用者应遵守服务条款、课程规则和适用法律。
