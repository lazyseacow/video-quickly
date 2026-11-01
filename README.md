# Video Quickly

## 项目介绍

Video Quickly 是本地视频创作工作台，覆盖创意简报、资料整理、分镜剪辑、配音字幕、审阅和导出。支持连接 AI 模型辅助创作，也可导入已有素材编辑。

## 核心功能

- **分镜与剪辑**：编辑画面、旁白、时长和运镜，支持关键帧、时间轴预览、分割、裁剪和批量调整。
- **配音与字幕**：支持语音生成、语音识别、字幕编辑、背景音乐和混音。
- **模型与工作流**：配置文本、图片、视频和音频模型，查看 Token 消耗；自定义流程、复用子流程，支持并行生成、人工审阅和恢复执行。
- **素材与模板**：管理素材、角色参考、系列模板和 Skill，复用创作资源。
- **项目管理**：支持草稿恢复、撤销重做、项目备份与导入。
- **视频导出**：导出 MP4、字幕和分镜，支持横屏、竖屏、方形等多比例批量导出。

## 安装运行

准备 Node.js 24 和 pnpm 10，具体版本以仓库配置为准。桌面客户端使用 Electron 和随附 Chromium，通过独立 Node 执行器管理项目、生成与媒体处理。以下命令均在项目根目录执行。

```sh
pnpm install --frozen-lockfile
```

### Windows 10／11 x64

安装锁定的项目依赖后准备媒体组件：

```powershell
pnpm prepare:media
pnpm dev:desktop
```

首次运行时执行 `pnpm prepare:media`，准备 FFmpeg 和 FFprobe。

### macOS 13.5 及以上（Apple Silicon／Intel）

分别支持 arm64 和 x64，依赖与执行器按当前 CPU 原生构建。

```sh
pnpm prepare:media
pnpm dev:desktop
```

`prepare:media` 下载经过固定 SHA-256 校验的独立 FFmpeg／FFprobe，包含字幕渲染与 H.264 编码，不依赖 Homebrew。生产打包自动准备官方独立 Node.js 24；开发模式也可使用 Homebrew Node。

### 浏览器预览

运行 `pnpm dev`，访问 <http://127.0.0.1:1420>。模型生成功能需在应用的“模型连接”中配置服务。

## 打包说明

Windows x64、macOS arm64／x64 均可在对应原生机器完成环境准备后执行：

```powershell
pnpm build:desktop
```

产物在 `.generated/electron-release/`：Windows 为 NSIS 安装器，macOS 为可独立解压的 `.app` ZIP。每个 Mac 架构分别构建、验收，不将一个架构的本地结果代替另一个架构。打包命令固定 `--publish never`，不会自动发布。

桌面专项验收：`pnpm test:desktop`；打包后使用 `pnpm test:desktop --packaged` 验证真实打包应用。验收使用独立临时工作区，不读取日常模型密钥或提交付费任务。

## 数据与文档

Windows 默认工作区为 `%APPDATA%\VideoQuickly-Electron`，macOS 为 `~/Library/Application Support/VideoQuickly-Electron`。Chromium 配置与编辑草稿位于工作区的 `electron-session`；系统凭据保存在操作系统凭据库。

- [Electron 架构与验收](docs/electron-desktop.md)
- [功能现状与开发边界](docs/development-plan.md)
- [读取、编辑与恢复契约](docs/workspace-editing.md)
- [持久化执行契约](docs/durable-execution.md)
- [Windows 验收](docs/windows-verification.md)与 [macOS 验收](docs/macos-verification.md)
- [外部服务与性能验收](docs/release-validation.md)
