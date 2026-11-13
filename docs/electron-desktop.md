# Electron 桌面架构与验收

Video Quickly 使用 Electron 加载 React 工作台，通过沙箱预加载桥接独立 Node 执行组件。正式支持 Windows 10／11 x64 和 macOS 13.5 及以上的 arm64／x64；两个 Mac 架构分别构建与验收。

## 代码入口

| 层 | 入口与职责 |
| --- | --- |
| Electron 主进程 | [桌面包清单](../src/package.json) 的 `main` 指向 [main.mjs](../src/electron/main.mjs)，管理窗口、应用生命周期和执行器。[desktop-ipc.mjs](../src/electron/desktop-ipc.mjs) 的 `registerDesktopIpc` 注册 IPC 并校验调用来源，同一模块转发执行器事件。 |
| 沙箱预加载 | `BrowserWindow` 加载 [preload.cjs](../src/electron/preload.cjs)，用 `contextBridge` 暴露 `window.videoQuickly`。`pnpm typecheck` 按 [desktop-bridge.ts](../src/packages/contracts/src/desktop-bridge.ts) 中的共享类型检查预加载接口。 |
| React 渲染进程 | [App.tsx](../src/renderer/App.tsx) 管理应用导航和工作区连接，[Workbench.tsx](../src/renderer/features/Workbench.tsx) 管理当前项目的编辑。[use-workbench-production.ts](../src/renderer/features/use-workbench-production.ts) 协调制作前检查、启动、取消和按钮焦点。[client.ts](../src/renderer/lib/client.ts) 提供 RPC 与事件订阅。 |
| Node 执行器 | [runtime-controller.mjs](../src/electron/runtime-controller.mjs) 管理子进程并分派标准输入输出上的 JSON-RPC 消息。[main.ts](../src/packages/runtime/src/main.ts) 接收请求，[index.ts](../src/packages/runtime/src/index.ts) 将请求分发到工作区服务。素材的导入、查询、预览和回收站状态由 [asset-library.ts](../src/packages/runtime/src/asset-library.ts) 处理。 |
| 浏览器开发与回归 | [vite.config.ts](../src/vite.config.ts) 配置前端构建和开发服务。[runtime-preview-bridge.ts](../src/dev/runtime-preview-bridge.ts) 在服务端提供本地 HTTP RPC、事件和媒体。预览服务与独立执行器复用 [Runtime 的 Node 入口](../src/packages/runtime/src/node.ts) 中的媒体回调。桌面开发由 Vite 提供页面资源，业务请求通过预加载。 |

### 工作台导出 MP4

1. 工作台先保存当前编辑，再打开 [ProjectExportDialog.tsx](../src/renderer/components/ProjectExportDialog.tsx)。用户在弹窗中可选本次成片规格。选择输出位置时，路径控件调用 `window.videoQuickly.pickPath`，经 `vq:pick-path` 进入系统保存对话框。
2. 点击「导出 MP4」后，弹窗通过渲染端 RPC 客户端提交 `render.export`。预加载将 `{ method, params }` 送到 `vq:runtime`。主进程校验窗口、主框架、来源和请求，再由执行器控制器通过标准输入输出转发。
3. 执行器将 `render.export` 交给 [run-start.ts](../src/packages/runtime/src/run-start.ts)，读取已保存项目、冻结导出快照并安排本地渲染。工作台跟随 `vq:runtime-event` 刷新运行状态。完成后弹窗通过 `node.result` 读取导出路径。

`pnpm test:desktop --compact` 在真实窗口中操作导出弹窗，核对保存结果与 MP4 画面规格。[原生用例](../scripts/native-compact-dialogs.mjs)

## 进程与安全边界

- `BrowserWindow` 加载工作台，画面预览复用 `<video>` 与 Canvas。Electron 与 electron-builder 的锁定版本见[桌面包清单](../src/package.json)和 [pnpm-lock.yaml](../pnpm-lock.yaml)。
- 主进程开启 `contextIsolation`、渲染沙箱及 `webSecurity`，关闭页面 Node 集成及 Electron 的 `webviewTag`。权限请求默认拒绝，仅允许当前可信主窗口文档通过用户操作进入播放器全屏；子帧、其他窗口、外部页面及自动全屏继续拒绝。
- 预加载暴露 Runtime RPC、事件订阅、路径选择、素材地址和文件定位。macOS 还提供等待原生窗口进入全屏的接口，播放器会在窗口切换完成后执行动画期间收到的退出请求。主进程校验当前主窗口、主框架与来源地址，并拒绝页面直接调用 `host.*` 系统接口。
- 生产页面与工作区媒体通过 `video-quickly://app` 加载。协议支持 GET、HEAD 与单段 Range；真实路径及符号链接边界检查阻止读取工作区外文件。外部 HTTP(S) 链接由系统浏览器打开。
- LangGraph、SQLite、媒体处理和重型依赖运行在独立 Node 24 执行组件，保留 Node 自身 ABI。Electron 仅加载系统凭据及 Windows 进程容器所需的原生绑定。
- PDF 初始化和文字提取使用专用 Node 子进程，保留文件大小、页数、正文长度、超时及退出清理限制；PDF.js 的 worker、字体和 wasm 随执行组件携带。
- 系统凭据使用 `@napi-rs/keyring` 的异步接口，服务名称为 `video-quickly-electron`。操作按顺序执行；已保存密钥不向渲染页面回传，也不进入项目备份或可提交日志。
- Windows JobObject 通过 Koffi 管理执行器进程树。主进程异常退出后，系统容器回收执行器及其子进程；相关真实进程测试与打包应用验收分别记录。

## 工作区与持久化

| 内容 | Windows | macOS |
| --- | --- | --- |
| 默认工作区 | `%APPDATA%\VideoQuickly-Electron` | `~/Library/Application Support/VideoQuickly-Electron` |
| Chromium 配置、偏好与草稿 | 工作区中的 `electron-session` | 工作区中的 `electron-session` |

`VIDEO_QUICKLY_DATA_DIR` 可指定工作区，`VIDEO_QUICKLY_ELECTRON_USER_DATA` 可独立指定 Chromium 配置目录。桌面开发使用同一套默认目录规则，可按[启动命令](../README.md#从源码运行)指定单独工作区。原生验收会创建独立的临时工作区和 Chromium 配置。

新工作区从空项目列表开始。从「我的项目」卡片点击「继续创作」进入工作台，首次使用可按指南操作。指南按用户实际操作的结果推进，导出步骤等待成片完成。指南状态和外观偏好（`vq-theme`）保存在当前 Chromium 配置中，从左下角「设置」可重新打开指南或切换外观。导航、焦点与控件约定见[界面设计规范](../DESIGN.md)。

工作台阶段元数据随项目、草稿、备份和运行快照保存，供制作配置与自定义流程使用。配置步骤、冻结详情和进度状态见[生成进度契约](workspace-editing.md#制作指引与生成进度)。

项目、运行、检查点和素材元数据由 Runtime 的 SQLite 工作区保存；编辑草稿、选择镜头及增量撤销历史写入 IndexedDB，按工作区和项目隔离。正常存储条件下，项目保存先等待当前草稿意图的事务完成，再提交带修订号的更新。草稿存储故障会显示错误，仍允许手动保存项目。详见[读取与编辑契约](workspace-editing.md)及[持久化执行契约](durable-execution.md)。

Windows 卸载默认保留工作区。交互勾选删除或明确传入 `--delete-electron-workspace` 时，仅删除默认 Roaming 工作区；应用名称别名目录和同名 LocalAppData 目录不作为清理目标。移除 Mac `.app` 默认保留工作区。

## 窗口与执行组件生命周期

运行时每代进程独立管理。断连会结束当前未完成的本地请求，并显示可操作的连接状态；显式重连只重新读取持久化状态，不自动重提生成或导出。

Windows 关闭最后一个窗口会退出应用。macOS 关闭最后一个窗口后保留应用及执行组件，可从 Dock、应用激活或第二实例重新打开窗口；使用退出菜单或 ⌘Q 才退出应用。未保存内容的离开确认可取消，取消后继续保留当前执行器。确认退出后等待已接收的 Runtime 工作及关闭清理。

## 开发与打包

| 命令 | 行为 |
| --- | --- |
| `pnpm dev` | 启动本地浏览器预览与开发 RPC，默认端口 1420。 |
| `pnpm dev:desktop` | 构建执行器、准备开发组件，启动 Vite 和 Electron。默认独占 1420 端口，可通过 `VIDEO_QUICKLY_PORT` 指定开发端口。Electron 进程退出后关闭本次开发服务器。 |
| `pnpm build` | 构建执行器与生产前端。 |
| `pnpm build:desktop` | 准备独立 Node、媒体组件和许可，按 `electron-builder.yml` 生成当前原生平台的正式包。 |

打包配置的 `electron/**/*` 收录主进程与预加载模块，`dist/**/*` 收录 Vite 产物。[electron-builder.yml](../electron-builder.yml)

应用图标源文件为 [logo.svg](../src/renderer/assets/logo.svg)。修改后运行 `pnpm prepare:icons`，同步桌面图标、macOS 托盘模板和浏览器图标。桌面资源位于 [src/build/icons](../src/build/icons)，浏览器图标位于 [public/favicon.svg](../src/public/favicon.svg)。macOS 开发 Dock 的 `dock.png` 与正式包的 ICNS 共用构图，1024px 画布保留 100px 透明边距。

正式包只加载随附资源。执行组件位于 `resources/sidecar`，Mac 对应 `.app/Contents/Resources/sidecar`，不回退宿主媒体工具。Windows 输出 NSIS x64 安装器，Mac 两架构分别输出独立 `.app` ZIP；Linux 不属于正式交付矩阵。所有打包命令固定 `--publish never`。

Mac 正式组件使用固定摘要验证的官方独立 Node.js 和静态 FFmpeg／FFprobe；不复制 Homebrew 动态依赖。正式报告须为 `bundled-runtime-and-media`，开发目录包不能进入正式交付清单。Node、媒体、SQLite 和 Canvas 在仅保留系统 PATH 的环境验证；媒体源码、许可和固定构建配方随包保存。

## 验收门槛

从源码执行原生回归前，按平台准备媒体组件，在仓库根目录运行以下命令。

```sh
pnpm build
node scripts/prepare-sidecar.mjs --development
pnpm test:desktop
```

浏览器回归 `pnpm test:e2e` 默认使用端口 1421。多个工作目录并行执行时，通过 `VIDEO_QUICKLY_PORT` 分配不同端口。测试数据按本次运行隔离。用例和状态断言在本地分别默认 30 秒和 5 秒，在 CI 分别默认 90 秒和 30 秒。单个用例可以设置自己的预算，自动重试次数为 0。[Playwright 配置](../playwright.config.ts)

1. 类型检查、Runtime／SQLite／契约测试和完整浏览器流程通过。
2. `pnpm test:desktop` 在临时工作区启动真实 Electron，验证生产协议、沙箱预加载、IPC／Node、系统凭据、编辑历史、只读制作检查、同身份素材恢复与媒体自动重读、媒体 Range／路径边界、实际 MP4、转场关键帧与播放器像素对照、断连重连及重启草稿。正式包清单必须包含制作检查和素材恢复的原生通过记录。
3. `pnpm test:desktop --packaged` 对本次实际打包应用执行同样的原生检查。macOS 验收记录退出点击与原生进入事件的时差，确认动画期间点击后，播放器和窗口均能退出全屏。
4. 包外执行独立 PDF 解析，本地 HTTP CLI 验证恢复和三比例成片，FFmpeg 实际编码覆盖横屏、竖屏、方形及 4K。
5. Windows 在含中文和空格的路径验证安装与覆盖，并检查既有运行、默认卸载保留及明确删除的范围。macOS 实际解压 ZIP 后验证应用覆盖、既有运行和移除应用后的数据保留。
6. 明暗主题、自定义主题、代表性窗口、减少动效和焦点行为由生产组件测试；CSS 静态检查核对统一令牌。

[Desktop verification](https://github.com/lazyseacow/video-quickly/actions/workflows/ci.yml) 在 Windows 和两个 Mac 架构执行完整矩阵。每次交付核对对应提交、实际包、清单和安装记录的 SHA-256，失败或缺少报告时不生成成功清单。平台专项及证据见 [Windows 验收](windows-verification.md)和 [Mac 验收](macos-verification.md)。

[Desktop package verification](https://github.com/lazyseacow/video-quickly/actions/workflows/desktop-packages.yml) 在推送 `codex/package-verification/**` 分支或手动运行时执行 Windows x64 和 Intel macOS 的打包、完整原生回归及隔离安装验收。按产物名称中的提交 SHA 核对报告。

浏览器中的故意缺失素材与制作检查夹具使用 `preview:e2e` 的同一真实 HTTP、事件和媒体桥接，每条测试拥有独立预览进程、随机端口和临时工作区，复用已构建的客户端。结束时等待执行器与媒体读取器关闭、确认子进程退出后，仅清理该夹具创建且归属未变化的目录；故障文件不会混入其他并行测试的项目封面或素材库。

浏览器测试固定 Playwright 1.64.1，并通过 `pnpm patch` 回移[官方 TCP 随机端口修复 #43605](https://github.com/microsoft/playwright/pull/43605)。该补丁保留原 Chromium 配置，只向已有禁用列表加入 `TcpPortRandomizationWin`，处理 Windows Server 2025 上加载本地资源的 `ERR_NO_BUFFER_SPACE`。升级到包含此修复的稳定版本后，应移除补丁并重跑三平台验收。

## 验收与分发边界

原生专项通过真实预加载和 IPC 调用系统接口，但文件选择、保存与离开确认的用户决定由自动化提供；系统对话框、Finder／Explorer 的实际鼠标交互须在对应桌面人工验证。物理 GPU／驱动长时采样、供应商计费／取消语义和真实视频服务按[外部服务与性能验收](release-validation.md)单独记录。窗口报告保留实际几何与工作区限制，不把低于应用最小窗口尺寸的环境称为完整可见性验证。

安装包当前未签名／公证，不包含自动更新发布流程。应用代码、Electron、构建器及原生绑定的许可证不能替代 Node、Chromium 或 FFmpeg 的组件许可；交付需保留随包许可及媒体来源资料。
