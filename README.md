# Video Quickly

## 项目介绍

Video Quickly 是面向通用视频制作的本地创作工作台，覆盖策划分镜、素材配音、剪辑动画、审阅和导出。支持连接 AI 模型辅助创作，也可导入已有素材编辑。

默认视频制作采用四个阶段：**策划与分镜 → 素材与配音 → 剪辑与动画 → 审阅与导出**。从工作台“制作设置”统一选择文本模型与视频模型，一次保存全部阶段，也可直接保存并开始制作。策划任务共用文本模型，视频模型同步生成画面、人声与环境音；参考图可选用已有素材或图片模型。“素材与配音”可添加本地 WAV / MP3 作为 Seedance 2.0／2.5 的参考音频，随制作配置保存。字幕默认关闭，可按需显示分镜文本并核对预估时间。

统一面板提供创作要求、视觉风格、声音要求和成片规格。成片默认选择字幕、比例和分辨率；自定义尺寸、帧率与素材适配在“更多成片设置”中调整。高级设置按需选择一个任务，修改其独立模型、提示词与 Skill。默认任务依次为简报、风格、分镜、参考素材准备、镜头视频生成、剪辑准备与导出。生成视频验证真实音轨与时长，原声贯通预览和成片。自定义流程使用显式任务定义，运行快照固定本次制作参数。

制作配置统一从“制作设置”进入：创作与模板放在策划分区，素材、声音要求和背景音乐放在素材分区，成片规格和字幕样式放在导出分区。预览质量在画面预览标题栏直接调整，本机记住选择；项目备份位于“我的项目”的卡片操作中。可以先保存项目配置，开始制作时再校验模型；打开附属工具前会保存当前输入。运行中保存的配置用于下次制作。

工作台顶部保留完整阶段进度，高亮正在执行的阶段。阶段卡片始终打开“制作设置 / 本次制作”面板：有配置的阶段定位设置，自动执行的剪辑与动画定位制作记录；制作设置仅展示有配置项的分区，镜头裁剪、运镜和转场在工作台调整。运行中可保存下次制作的待用配置，本次参数保持不变。任务自动使用已生成的简报、风格、分镜和素材继续下一步，完整制作结束后自动保存项目；期间项目内容已修改时保留编辑并保存生成产物供查看。单独执行任务时，其余阶段继续显示，产物沿用候选应用方式。自定义流程与子流程同样自动接续；历史暂停运行可通过“继续”自动恢复。

## 核心功能

- **分镜与剪辑**：编辑画面、旁白、时长和运镜，支持关键帧、时间轴预览、分割、裁剪和批量调整。
- **声音与字幕**：支持视频原声、参考音频、字幕编辑和背景音乐。
- **模型与工作流**：配置文本、图片和视频模型，查看 Token 消耗；自定义流程、复用子流程，支持自动接续、并行生成和恢复执行。
- **素材与模板**：管理素材、角色参考、系列模板和 Skill，复用创作资源。
- **项目管理**：支持草稿恢复、撤销重做、项目备份与导入。
- **视频导出**：导出 MP4、字幕和分镜，支持横屏、竖屏、方形等多比例批量导出。
- **应用设置**：从侧栏左下角的“设置”打开紧凑浮层，使用胶囊按钮切换浅色／深色外观，并进入 Token 消耗或使用指南。

## 安装运行

准备 Node.js 24 和 pnpm 10，具体版本以 [.node-version](.node-version) 和 [package.json](package.json) 为准。桌面客户端使用 Electron 和随附 Chromium，通过独立 Node 执行器管理项目、生成与媒体处理。以下命令均在项目根目录执行。

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

开发检查使用 `pnpm typecheck`、`pnpm test` 和 `pnpm build`；`pnpm check` 顺序执行这三项。浏览器、媒体与真实桌面验收分别使用 `pnpm test:e2e`、`pnpm test:media` 和 `pnpm test:desktop`，具体覆盖与平台边界见下列文档。

## 数据与文档

Windows 默认工作区为 `%APPDATA%\VideoQuickly-Electron`，macOS 为 `~/Library/Application Support/VideoQuickly-Electron`。Chromium 配置与编辑草稿位于工作区的 `electron-session`；系统凭据保存在操作系统凭据库。

| 文档 | 内容 |
| --- | --- |
| [功能现状与开发边界](docs/development-plan.md) | 当前已实现能力、代码与验证入口 |
| [界面设计规范](DESIGN.md) | 四阶段工作台、主题令牌、公共控件与交互约定 |
| [读取、编辑与恢复契约](docs/workspace-editing.md) | 阶段进度、项目读取、草稿、剪辑、素材与产物应用 |
| [持久化执行契约](docs/durable-execution.md) | 冻结快照、执行范围、审阅、回执与任务恢复 |
| [Electron 架构与验收](docs/electron-desktop.md) | 桌面进程、IPC、安全、工作区和构建流程 |
| [日志规范](docs/logging.md) | 日志位置、级别、轮转、脱敏与排查 |
| [Windows 验收](docs/windows-verification.md)／[macOS 验收](docs/macos-verification.md) | 对应平台的实际包、安装与数据保留验收 |
| [外部服务与性能验收](docs/release-validation.md) | 真实供应商、长时播放和人工桌面验证 |

## 日志与排查

运行日志自动保存在工作区的 `logs/` 目录，桌面外壳记录在 `desktop.log`，执行器与浏览器预览记录在 `runtime.log`。日志按大小轮转，默认记录关键操作及异常，支持临时开启调试级别。具体路径、字段、脱敏范围和排查步骤见 [日志规范](docs/logging.md)。
