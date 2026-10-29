# Video Quickly

可逐步微调的视频创作工作台。以历史手绘科普为首个模板，支持项目、分镜、视频规格、模型和 Skill 管理，以及持久化的步骤执行与人工审阅。

## 开发

运行环境为 Node.js 24 LTS、pnpm 10。首次运行：

```powershell
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:1420>。开发预览连接同一套 TypeScript 执行层，数据保存在 `.data/development/`；`VIDEO_QUICKLY_DATA_DIR` 可指定隔离数据目录。此开发桥接只用于 Vite 开发模式。

桌面应用使用 Tauri IPC 与 Node 附属进程通信。桌面开发与打包另外需要 Rust MSVC 工具链、Visual Studio C++ Build Tools 和 WebView2。桌面开发前先构建随附组件：

```powershell
pnpm build
node scripts/prepare-sidecar.mjs
pnpm dev:desktop
pnpm build:desktop
```

FFmpeg 和 FFprobe 需要完整媒体构建。开发模式自动发现 `.tools/` 中的便携构建，也可设置 `VIDEO_QUICKLY_FFMPEG` 和 `VIDEO_QUICKLY_FFPROBE`。安装包准备脚本可通过 `VIDEO_QUICKLY_MEDIA_DIR` 指定包含媒体组件与许可声明的目录。

模型服务由用户配置；本地示例素材用于检查编辑和渲染，旁白与事实主张仍待核验。未加入旁白音频时，导出面板会标明静音画面小样。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

首次运行浏览器验证时可执行 `pnpm exec playwright install chromium`。测试应使用临时数据目录，隔离真实模型与用户项目。媒体测试使用真实 FFmpeg；云端调用测试仅替换网络边界。

## 工程结构

- `apps/desktop`：React 工作台及 Tauri 原生外壳。
- `packages/contracts`：TypeScript 类型、Zod 输入契约、视频规格及工作流定义。
- `packages/runtime`：LangGraph 编排、SQLite 持久化、模型与 Skill 管理、进程通信。
- `packages/integrations`：模型媒体适配、自定义 HTTP 请求、ComfyUI 映射和远端任务回执。
- `packages/video`：场景预览、时间轴、字幕和视频输出。
- `.agents/skills/make-interfaces-feel-better`：本项目采用的前端设计与验收 Skill。

## 制作流程

简报 → 资料与史实 → 风格与角色 → 旁白与分镜 → 素材 → 配音字幕 → 动画运镜 → 小样审阅 → 导出。

步骤视图与流程图操作同一份工作流，支持依赖连接、条件分支和人工审阅。项目规格与素材生成规格分别管理，帧率按分数保存，镜头时间以微秒保存，运镜按镜头时间计算。修改项目会创建新修订，已有运行固定原快照。

在工作台编辑镜头旁白、画面、时长和运镜；在项目设置调整尺寸、比例和帧率；导出面板可单独覆盖输出规格。模型生成的分镜与风格作为步骤产物保存，审阅后可应用到项目，修订检查会阻止覆盖后续人工修改。

时间尺支持持续拖动，画面随位置更新，编辑中的镜头保持选中。方向键按项目帧率前后移动一帧，按住 Shift 移动十帧，Home / End 定位首尾，Space 播放或暂停。时间轴缩放尽量保持播放头在视口中的位置，适配按钮恢复完整视图。播放到末尾会停止，再次播放从开头开始；切到后台时暂停。

流程画布支持滚动平移、Ctrl + 滚轮缩放、空格 + 拖动平移，以及方向键移动所选步骤。背景任务刷新会保留本地编辑，切换视图或离开工作台前保存流程；发生外部流程版本冲突时，保留编辑并提供明确的重新载入操作。

交互实现参考 [Motion Canvas Player](https://github.com/motion-canvas/motion-canvas/blob/main/packages/core/src/app/Player.ts) 的播放与定位分离、[Excalidraw](https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/utils.ts) 的最新指针位置合并，以及 [React Flow 性能指南](https://reactflow.dev/learn/advanced-use/performance) 的稳定组件与事件引用。播放状态仅由预览和时间尺订阅；图片按素材版本共享缓存，视频定位等待上次解码完成后应用最新位置。

工作区结构参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/client/ui-layout)：最近项目位于左侧导航，项目操作集中在一行，镜头与制作步骤使用大纲标签切换，时间轴横跨预览和属性区域。两侧面板可收起；宽窗口支持拖动调宽、方向键微调与双击复位，并保存布局偏好。“专注预览”临时展开画面空间，退出后恢复原面板。窄窗口自动收拢导航并将属性移至下方。

项目可备份为包含 `project.json` 和素材文件的目录，再通过“我的项目 → 导入项目”恢复为独立副本。素材库支持保留、选择和移除未使用的版本；移除记录会保留磁盘文件。

## 模型和 Skill

在“模型连接”配置协议、服务地址、模型 ID 和能力。云模型使用系统凭据库；浏览器开发预览的密钥只在当前开发服务进程内存中保存。

支持 OpenAI 兼容文本、生图、配音接口，Ollama 文本、Seedream 生图、Seedance 视频、Qwen TTS、ComfyUI 和声明式自定义 HTTP。模型支持的具体尺寸、时长、音色和模型 ID 需要按照所接服务配置；真实云端验证需要用户自己的服务连接。

ComfyUI 高级参数使用 `workflow` 保存 API 格式的工作流，`inputMapping` 将 `prompt`、`narration`、`width`、`height`、`seed` 映射到“节点编号.输入名称”。自定义 HTTP 支持 `requestPath`、`requestTemplate`、`resultUrlPath`、`resultBase64Path`，异步接口另设 `taskIdPath`、`pollPath`、`statusPath`。模板变量包括 `{{prompt}}`、`{{narration}}`、`{{model}}`、`{{width}}`、`{{height}}`、`{{duration}}`。

Skill 可从本地目录、ZIP 或 GitHub 仓库导入，资源与版本随导入保存。Skill 中的 JavaScript 工具默认停用，需要单独启用；“工具连接”可登记 MCP 本地进程或 HTTP 服务，再绑定至 Agent 步骤。工具进程的工作目录和环境变量会受控，但其执行权限属于本机用户权限范围。

当前工作区按单实例、每项目一个活动任务运行，节点按依赖顺序执行。重用子流程、并行制作调度和完整多轨剪辑属于后续扩展。

## 执行与恢复

工作流使用 SQLite 检查点。模型与工具活动具有稳定操作标识，并保存输入摘要、结果和远端回执。继续执行会复用已经完成的活动；重新生成创建新的运行与操作标识。

人工审阅可以跨重启继续。外部提交结果不明确时会等待核对；已有远端任务编号时继续查询原任务。本地编码中断后可复用完整镜头并重新处理未完成片段。应用退出期间本地任务停止，下一次启动从持久记录继续。

完整约束见 [持久化执行](docs/durable-execution.md)。

## 后续开发

下一阶段按稳定交付、大项目性能与编辑效率、Agent 编排三阶段推进。具体依赖、实施顺序和验收标准见 [开发与优化计划](docs/development-plan.md)。

## 来源与许可

原创代码采用 MIT。历史模板参考 [gen-history-video](https://github.com/lazyseacow/gen-history-video) 的制作方法并独立编写；媒体流程研究参考用户的 video-generator 项目。界面使用 [make-interfaces-feel-better](https://github.com/lazyseacow/make-interfaces-feel-better) Skill。

第三方来源与许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
