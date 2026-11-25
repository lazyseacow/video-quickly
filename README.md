# Video Quickly

Video Quickly 是本地短剧制作工作室，以作品组织分集，支持剧本上传与创作、选题、画风、角色和音色、分镜、镜头制作、剪辑与导出。可以导入已有素材，也可以接入文本、图片和视频模型辅助制作。

## 开始制作

1. 从工作室菜单打开「对话」，发送小说原文、已有剧本或故事想法。可用输入区下面的创作起点指定任务，也可直接描述需求。工具栏支持读取 TXT、Markdown、DOCX 和含文本的 PDF。在同一张确认卡上填写作品名称、检查创作设置并创建第一集。
2. 需要 AI 生成时，在「模型连接」配置服务。从服务返回的列表选择模型，ComfyUI 使用工作流指定的模型。应用按服务和 API 协议处理鉴权。
3. 小说分集创建后直接进入「对话」。生成并审核导演剧本后，可结合创作 Skill 提取角色资产，确认角色后生成分镜并应用到本集。「工作室菜单」中的「最近分集」可继续之前的对话。在「分镜工作台」编辑镜头，并由「制作设置」配置模型、素材、声音和成片规格。已有剧本可从工作台的「分集剧本」编辑。
4. 点击「开始制作」。内置流程包含「策划与分镜」「素材与配音」「剪辑与动画」「审阅与导出」。小说改编分集使用已确认的策划产物，随后生成视频并导出。点击阶段卡片可查看进度、产物和重试入口。

也可在首页对话直接发送「帮我生成分镜：雨夜追车，20 秒，4 个镜头」。在对话中继续填写参考图和模型，再确认分析。已保存的分镜任务可从「创作设置 → 分镜创作记录」打开。

工作台用分镜卡片浏览、选择和拖拽排序镜头。镜头操作可移动、复制、分割或移除所选镜头，属性区可为单个镜头重新生成候选，也可调整入出点、字幕和运镜。「后期工具」提供背景音乐和项目字幕样式，顶部「检查」可核对已保存的制作配置。工作台提供撤销、重做和草稿恢复。点击「导出」可选择本次 MP4 的画面规格，也可导出字幕、分镜及多比例成片。剪映／CapCut 交接包和实验性工程草稿的使用条件见[素材扩展与剪辑交付](docs/media-extensions.md)。

「素材库」管理媒体和角色参考，「系列模板」复用画幅、视觉风格和配套 Skill。「Skill 工作室」支持导入本地目录、ZIP（最大 50 MB）或 GitHub 仓库／Skill 目录链接，可在提示词实验中离线查看编译结果后显式试运行。制作设置、首帧与参考素材、提示词实验及后台导入的细节见[工作区契约](docs/workspace-editing.md)。

「短剧工作室」是唯一制作入口，作品内管理分集，分集工作台的「场次与对白」编辑场次、人物形象、对白与旁白。「素材库」的角色和音色可跨分集复用，真人、二维、三维及绘本画风均可搭配对白、解说或混合讲述。使用与能力边界见[短剧制作与视听资产](docs/drama-studio.md)。

## 从源码运行

支持 Windows 10／11 x64 和 macOS 13.5 及以上的 Apple Silicon／Intel。准备 Node.js 24 和 pnpm 10，固定版本见 [.node-version](.node-version) 和 [package.json](package.json)。macOS 需安装 Xcode Command Line Tools，并使用与本机 CPU 架构一致的 Node.js。以下命令均在仓库根目录执行。

**Windows PowerShell**

```powershell
pnpm install --frozen-lockfile
pnpm prepare:media
$env:VIDEO_QUICKLY_DATA_DIR = Join-Path $PWD.Path '.data/electron-development'
pnpm dev:desktop
```

**macOS**

```sh
pnpm install --frozen-lockfile
pnpm prepare:media
VIDEO_QUICKLY_DATA_DIR="$PWD/.data/electron-development" pnpm dev:desktop
```

`prepare:media` 准备经过固定摘要校验的 FFmpeg 和 FFprobe。macOS 开发模式也支持使用 PATH 上带字幕渲染支持的 FFmpeg／FFprobe。上述数据目录用于将开发项目和 Chromium 草稿与日常使用隔离。

浏览器预览运行 `pnpm dev`，访问 <http://127.0.0.1:1420>。该模式使用本地 HTTP 桥接，适合调试界面和业务交互。原生文件选择、系统凭据和窗口行为通过 Electron 验证。[Electron 开发与打包](docs/electron-desktop.md#开发与打包)

## 验证与打包

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | 检查工作区各包、沙箱预加载和验证脚本。 |
| `pnpm test` | 运行单元与集成测试。可附加测试文件路径缩小范围。 |
| `pnpm test tests/design-token-contract.test.ts` | 单独运行 CI 的界面令牌静态契约检查。 |
| `pnpm build` | 构建 Node 执行器与生产前端。 |
| `pnpm check` | 依次执行类型检查、测试和构建。 |
| `pnpm test:e2e` | 运行浏览器回归。首次运行前执行 `pnpm exec playwright install chromium`。 |
| `pnpm test:media` | 验证实际媒体编码。 |
| `pnpm test:desktop` | 用独立临时工作区启动真实 Electron，检查生产协议、预加载与执行器。运行前先按[桌面验收说明](docs/electron-desktop.md#验收门槛)构建前端和执行器。 |
| `pnpm build:desktop` | 在当前原生平台生成桌面包。 |
| `pnpm test:desktop --packaged` | 对实际构建的桌面应用执行原生回归。 |

桌面包位于 `.generated/electron-release/`，Windows 输出 NSIS 安装器，macOS 按架构输出包含独立 `.app` 的 ZIP。构建命令使用 `--publish never`。实包验证、安装覆盖和数据保留分别见 [Windows 验收](docs/windows-verification.md)和 [macOS 验收](docs/macos-verification.md)。

## 代码入口

桌面应用包位于 `src/`，React 源码在 `src/renderer/`，独立执行器和共享包位于 `src/packages/`。

| 模块 | 从这里开始 |
| --- | --- |
| Electron 主进程 | [main.mjs](src/electron/main.mjs) 管理窗口、应用生命周期和 Node 执行器，[desktop-ipc.mjs](src/electron/desktop-ipc.mjs) 接入渲染端 IPC。 |
| 预加载 | [preload.cjs](src/electron/preload.cjs) 通过 `contextBridge` 暴露 `window.videoQuickly`，[desktop-bridge.ts](src/packages/contracts/src/desktop-bridge.ts) 定义桥接类型。 |
| React 工作台 | [main.tsx](src/renderer/main.tsx) 挂载应用外壳 [App.tsx](src/renderer/App.tsx)。项目编辑和制作从 [Workbench.tsx](src/renderer/features/Workbench.tsx) 进入，[client.ts](src/renderer/lib/client.ts) 提供 RPC 与事件订阅。 |
| Node 执行器 | [main.ts](src/packages/runtime/src/main.ts) 处理进程通信，[index.ts](src/packages/runtime/src/index.ts) 组装工作区服务和业务请求入口。 |
| 共享契约与媒体 | [contracts](src/packages/contracts/src/index.ts) 定义跨进程数据和校验，[video](src/packages/video/package.json) 提供媒体计算及 Node 专用入口，[integrations](src/packages/integrations/src/index.ts) 实现外部集成。 |

## 数据与专题文档

Windows 默认工作区为 `%APPDATA%\VideoQuickly-Electron`，macOS 为 `~/Library/Application Support/VideoQuickly-Electron`。Chromium 偏好与编辑草稿位于工作区的 `electron-session`，模型密钥保存在系统凭据库。运行日志在工作区的 `logs/`，桌面进程写入 `desktop.log`，执行器和浏览器预览写入 `runtime.log`。

| 文档 | 内容 |
| --- | --- |
| [Electron 架构与验收](docs/electron-desktop.md) | 桌面进程、导出调用链、IPC、工作区与构建流程。 |
| [功能现状与开发边界](docs/development-plan.md) | 功能索引和对应回归入口。 |
| [工作区读取、编辑与恢复](docs/workspace-editing.md) | 制作设置、草稿、素材、剪辑、提示词实验与性能基准。 |
| [持久化执行](docs/durable-execution.md) | 运行快照、外部操作、回执与任务恢复。 |
| [界面设计规范](DESIGN.md) | 四阶段工作台、主题令牌、公共控件与交互。 |
| [运行日志与排查](docs/logging.md) | 位置、字段、日志轮转与排查方法。 |
| [外部服务与性能验收](docs/release-validation.md) | 真实供应商、长时播放和人工桌面验证。 |
