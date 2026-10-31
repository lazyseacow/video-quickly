# Electron 桌面实现与验收

本轮范围：全局界面规范统一，桌面外壳从 Tauri 替换为 Electron，保持最终编辑、生成、恢复、资料、模板和导出能力一致。用户随后明确项目处于开发阶段，不要求兼容旧 Tauri 数据；本轮不附带旧 WebView／凭据迁移器，不修改或删除旧用户目录。

## 架构

- `BrowserWindow` 加载现有 React 工作台；预览继续复用 `<video>`／Canvas，不为每个镜头创建额外网页视图。
- Electron 45.2.1 和 electron-builder 26.18.0 精确锁定。前者来自官方稳定版本，后者复用成熟 NSIS 打包流程；未自行编写安装器。
- 主进程开启 `contextIsolation`、渲染沙箱，关闭页面 Node 集成及 `<webview>`。预加载只提供经过主进程校验的运行时、文件选择、媒体地址和目录定位接口。
- LangGraph、SQLite、FFmpeg 仍在独立的 Node 24 执行组件。它保留 Node 自身 ABI，`better-sqlite3`、Canvas 和 PDF 依赖不迁入 Electron 主进程。
- PDF 模块初始化及文字提取运行在专用 Node 工作线程，避免阻塞制作记录等请求；保留页数、正文与原文校验限制，解析超时或失败后回收线程，退出时等待已接收的读取完成。
- 凭据通过 `@napi-rs/keyring` 2.1.2 访问系统凭据库；页面不直接读取主机模块。新的服务名称与旧 Tauri 服务隔离。
- 本地 `video-quickly://app` 协议加载生产前端及工作区素材，支持 HTTP Range；路径规范化与真实路径边界阻止工作区外文件读取。
- Windows JobObject 使用 Koffi 3.3.6 调用系统原生接口，父进程异常退出后回收执行器及其子进程。
- 子进程每代独立管理。断连结束未完成请求，显式重连只重读持久化状态，不自动重试生成或导出。退出等待执行组件关闭。

## 数据与运行

默认工作区：Windows 为 `%APPDATA%\VideoQuickly-Electron`，macOS 为 `~/Library/Application Support/VideoQuickly-Electron`。Chromium 配置在该目录的 `electron-session` 中。`VIDEO_QUICKLY_DATA_DIR` 和 `VIDEO_QUICKLY_ELECTRON_USER_DATA` 可将测试工作区及浏览器配置隔离。

`pnpm dev:desktop` 构建执行器、准备开发执行组件，启动独占本机 1420 端口的 Vite 和 Electron。关闭客户端后同时关闭本次开发服务器。正式包只加载随附资源，忽略开发 URL。

`pnpm build:desktop` 先构建前端与执行器，再准备带许可和来源的 Node／FFmpeg，使用 `electron-builder.yml` 打包。Windows 输出 NSIS x64 安装器；macOS arm64／x64 分别输出独立应用 ZIP，Linux 尚非正式交付目标。正式包的执行组件位于 `resources/sidecar`（macOS 为 `.app/Contents/Resources/sidecar`）。macOS 生产组件始终使用经固定 SHA-256 验证的官方独立 Node.js 24.22.1 和 Martin Riedl 静态 FFmpeg／FFprobe 9.0.2；不复制 Homebrew 的动态库依赖。两个架构分别在原生 CI 构建，包内 Mach-O 的架构、最低系统和依赖扫描通过后才能归档。

早期 `--development` 符号链接目录包仅属于历史本机验证。本轮正式 Mac ZIP 必须报告 `bundled-runtime-and-media`；正式发布清单拒绝 `development-directory-bundle`。Node、FFmpeg／FFprobe、原生 SQLite／Canvas 均在仅保留系统 PATH 的环境验证，源码、许可与固定构建配方随媒体组件携带。详见 [macOS 正式验收](macos-verification.md)。

## 验收门槛

1. 完整类型检查、真实 Runtime／SQLite／合同测试和现有浏览器流程保持通过。
2. `pnpm test:desktop` 启动真实 Electron 及沙箱预加载，使用临时目录验证生产协议、真实 IPC／Node、编辑撤销重做、媒体 Range／路径边界、实际 MP4 导出、执行组件异常退出／重连和关闭重启后的草稿恢复。
3. `pnpm test:desktop --packaged` 对实际打包应用重复上述门槛，不能用浏览器预览冒充桌面通过。
4. Windows CI 中安装到含中文和空格的目录，启动已安装 Electron 验证默认工作区、FFmpeg、真实预加载桥接及退出清理；重复安装后继续原待审任务、导出成片；默认卸载前后核对数据库、WAL 和夹具媒体的长度与 SHA-256，再验证明确删除数据的卸载参数。
5. 保留原四组实际 FFmpeg 编码、独立打包 PDF 和 HTTP 恢复测试。发布清单必须包含 Electron 原生报告，失败时不能生成成功交付清单。
6. 明暗主题、1536／600px、减少动效和自定义主题由真实生产组件验证；界面静态约束避免新增硬编码主题值。

Windows 与两个 Mac 架构均运行完整回归；原生专项脚本的文件选择结果由 Playwright 替代用户选择，覆盖真实预加载／IPC／对话框参数和取消处理；系统选择器的实际鼠标操作仍需对应桌面人工验证。Windows GPU、驱动与长时窗口进程采样、真实视频生成和供应商故障语义继续需要对应设备与服务。迁移 Electron 不会把这些项目自动变成已通过。

当前安装包未签名，构建不发布 Release；签名与更新分发需独立配置。当前实现进度与实际通过记录以本轮命令产物和提交对应 CI 为准，旧 Tauri 的历史成功运行不能作为 Electron 的通过证据。

## 依赖核对

2026-10-31 核对 [Electron 45.2.1](https://github.com/electron/electron/releases/tag/v45.2.1)、[electron-builder](https://github.com/electron-userland/electron-builder) 和其[官方 NSIS 配置](https://www.electron.build/nsis/)。Electron、electron-builder、系统凭据绑定及 Windows JobObject 的 Koffi 绑定均为 MIT；Node、Chromium 和 FFmpeg 的各自许可随实际产物收集，不以外壳许可证替代组件许可证。
