# Video Quickly

## 项目介绍

Video Quickly 是面向通用视频制作的本地创作工作台，覆盖策划分镜、素材配音、剪辑动画、审阅和导出。支持连接 AI 模型辅助创作，也可导入已有素材编辑。

新项目采用四个制作阶段：**策划与分镜 → 素材与配音 → 剪辑与动画 → 审阅与导出**。每个阶段集中配置相关任务的模型与提示词，一次保存；创作方案和最终小样各保留一次人工审阅。运行时仍按任务依赖执行，支持分别查看产物、定位错误和恢复制作。已有项目保留其保存的流程。

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

安装 Xcode Command Line Tools，使用与本机 CPU 架构一致的 Node.js。分别支持 arm64 和 x64，依赖与执行器按当前 CPU 原生构建。准备媒体组件后运行：

```sh
pnpm prepare:media
pnpm dev:desktop
```

`prepare:media` 下载经过固定 SHA-256 校验的独立 FFmpeg／FFprobe，包含字幕渲染与 H.264 编码，不依赖 Homebrew。生产打包自动准备官方独立 Node.js 24；开发模式也可使用 Homebrew Node。

仅启动和编辑项目时，可跳过媒体准备；开发模式也支持通过 PATH 使用带字幕渲染支持的 FFmpeg（例如 Homebrew 的 `ffmpeg-full`）。

### 更新应用图标

应用内标志的源文件为 `apps/desktop/src/assets/logo.svg`。修改后在项目根目录执行 `pnpm prepare:icons`，复用现有 Canvas 和 Electron Builder 工具同步生成桌面图标（PNG、ICO、ICNS）、macOS 托盘模板和浏览器图标。桌面资源保存在 `apps/desktop/build/icons/`；macOS 图标在 1024px 画布中保留 100px 透明边距，开发模式的 Dock 使用 `dock.png`，正式包的 ICNS 使用同一构图。应用内标志随明暗主题调整颜色，系统托盘提供显示主窗口和退出入口。

### 浏览器预览

运行 `pnpm dev`，访问 <http://127.0.0.1:1420>。模型生成功能需在应用的“模型连接”中配置服务。

## 打包说明

Windows x64、macOS arm64／x64 均可在对应原生机器完成环境准备后执行：

```powershell
pnpm build:desktop
```

产物在 `.generated/electron-release/`：Windows 为 NSIS 安装器，macOS 为可独立解压的 `.app` ZIP。每个 Mac 架构分别构建、验收，不将一个架构的本地结果代替另一个架构。打包命令固定 `--publish never`，不会自动发布。

macOS ZIP 未签名，最低系统版本为 13.5；可运行 `node scripts/verify-macos-bundle.mjs` 检查架构、最低系统版本和动态库依赖。

桌面专项验收：`pnpm test:desktop`；打包后使用 `pnpm test:desktop --packaged` 验证真实打包应用。验收使用独立临时工作区，不读取日常模型密钥或提交付费任务。

浏览器回归使用 `pnpm test:e2e`，默认端口为 1421。多个工作目录同时验证时，可通过 `VIDEO_QUICKLY_PORT` 指定不同端口；各次运行的数据目录独立。

## 数据与文档

Windows 默认工作区为 `%APPDATA%\VideoQuickly-Electron`，macOS 为 `~/Library/Application Support/VideoQuickly-Electron`。Chromium 配置与编辑草稿位于工作区的 `electron-session`；系统凭据保存在操作系统凭据库。

- [Electron 架构与验收](docs/electron-desktop.md)
- [功能现状与开发边界](docs/development-plan.md)
- [读取、编辑与恢复契约](docs/workspace-editing.md)
- [持久化执行契约](docs/durable-execution.md)
- [Windows 验收](docs/windows-verification.md)与 [macOS 验收](docs/macos-verification.md)
- [外部服务与性能验收](docs/release-validation.md)

## 日志与排查

运行日志自动保存在工作区的 `logs/` 目录，桌面外壳记录在 `desktop.log`，执行器与浏览器预览记录在 `runtime.log`。日志按大小轮转，默认记录关键操作及异常，支持临时开启调试级别。具体路径、字段、脱敏范围和排查步骤见 [日志规范](docs/logging.md)。
