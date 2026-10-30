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

准备 Node.js 24、pnpm 10 和 Rust，具体版本以仓库配置为准。以下命令均在项目根目录执行。

```sh
pnpm install
```

### Windows x64

使用 Rust MSVC 工具链，并安装 Visual Studio C++ Build Tools 和 WebView2。

```powershell
pnpm prepare:media
pnpm dev:desktop
```

首次运行时执行 `pnpm prepare:media`，准备 FFmpeg 和 FFprobe。

### macOS

安装 Xcode Command Line Tools。音视频处理和导出需带字幕渲染支持的 FFmpeg，可通过 Homebrew 准备：

```sh
brew install ffmpeg-full
export PATH="$(brew --prefix ffmpeg-full)/bin:$PATH"
pnpm dev:desktop
```

仅启动和编辑项目时，可跳过 FFmpeg 安装。

### 浏览器预览

运行 `pnpm dev`，访问 <http://127.0.0.1:1420>。模型生成功能需在应用的“模型连接”中配置服务。

## 打包说明

当前支持 Windows x64 安装包；macOS 支持开发运行。在 Windows 完成环境准备后执行：

```powershell
pnpm build:desktop
```

安装包默认生成在 `apps/desktop/src-tauri/target/release/bundle/nsis/`。
