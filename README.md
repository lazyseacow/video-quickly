# Video Quickly

## 项目介绍

Video Quickly 是本地视频创作工作台，支持从创意简报、资料整理、分镜与素材制作，到配音字幕、审阅和视频导出的完整流程。可连接 AI 模型辅助创作，也可导入已有素材逐镜编辑。

## 核心功能

- **分镜与剪辑**：编辑画面、旁白、时长和运镜，支持时间轴预览、分割、裁剪和批量调整。
- **配音与字幕**：支持语音生成、语音识别、字幕编辑、背景音乐和混音。
- **模型与工作流**：分别配置文本、图片、视频和音频模型，查看 Token 消耗；自定义制作步骤并人工审阅、继续执行。
- **素材与模板**：管理素材、角色参考、系列模板和 Skill，复用创作资源。
- **项目管理**：支持草稿恢复、撤销重做、项目备份与导入。
- **视频导出**：导出 MP4、字幕和分镜，支持横屏、竖屏、方形等多比例批量导出。

## 安装运行

当前以 Windows x64 为主要开发和打包环境。准备 Node.js 24、pnpm 10；桌面端还需 Rust MSVC 工具链、Visual Studio C++ Build Tools 和 WebView2。

在项目根目录执行：

```powershell
pnpm install
pnpm prepare:media
pnpm dev:desktop
```

`pnpm prepare:media` 下载并校验 FFmpeg 和 FFprobe，首次运行时执行。模型生成功能需在应用的“模型连接”中配置对应服务。

如需浏览器开发预览，运行 `pnpm dev`，访问 <http://127.0.0.1:1420>。

## 打包说明

完成上述环境与依赖准备后，在项目根目录执行：

```powershell
pnpm build:desktop
```

Windows 安装包默认生成在 `apps/desktop/src-tauri/target/release/bundle/nsis/`。若设置了 `CARGO_TARGET_DIR`，则位于该目录的 `release/bundle/nsis/` 下。
