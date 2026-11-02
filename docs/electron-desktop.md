# Electron 桌面架构与验收

Video Quickly 使用 Electron 加载 React 工作台，通过沙箱预加载桥接独立 Node 执行组件。正式支持 Windows 10／11 x64 和 macOS 13.5 及以上的 arm64／x64；两个 Mac 架构分别构建与验收。

## 进程与安全边界

- `BrowserWindow` 加载工作台，画面预览复用 `<video>` 与 Canvas。Electron 45.2.1、electron-builder 26.18.0 的实际锁定版本以包清单和 `pnpm-lock.yaml` 为准。
- 主进程开启 `contextIsolation`、渲染沙箱及 `webSecurity`，关闭页面 Node 集成及 Electron 的 `webviewTag`。权限请求默认拒绝。
- 预加载仅暴露 Runtime RPC、事件订阅、路径选择、素材地址和文件定位。主进程校验当前主窗口、主框架与来源地址，并拒绝页面直接调用 `host.*` 系统接口。
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

`VIDEO_QUICKLY_DATA_DIR` 可指定工作区，`VIDEO_QUICKLY_ELECTRON_USER_DATA` 可独立指定 Chromium 配置目录。开发、自动测试和日常使用应采用各自的数据目录。

首次打开工作区时会显示使用指南，逐步高亮实际的新建项目、模型连接、镜头、预览、时间轴、属性、制作检查与导出区域。可直接操作高亮区域，成功创建、保存、播放、定位或提交制作后自动进入下一步；导出步骤等待实际导出成功。打开表单时导览暂时让出操作空间，成功并关闭表单后继续，失败或取消则保留当前步骤。说明浮层跟随目标滚动和窗口尺寸变化，收起的面板会指向其展开按钮；也可手动切换步骤或跳过。完成、跳过或关闭后，会在当前 Chromium 配置中记住状态；侧栏底部的“使用指南”可随时重新打开。导览只响应用户的操作，不主动创建、保存或提交制作任务。

通用新项目的制作入口按“策划与分镜、素材与配音、剪辑与动画、审阅与导出”四个阶段组织，相关任务可在同一配置窗口一次保存。阶段信息随项目、草稿和备份保留；运行进度使用开始制作时冻结的阶段信息，后续编辑不会改写已有运行的分组。没有阶段信息的已有流程继续按原任务展示。

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

正式包只加载随附资源。执行组件位于 `resources/sidecar`，Mac 对应 `.app/Contents/Resources/sidecar`，不回退宿主媒体工具。Windows 输出 NSIS x64 安装器，Mac 两架构分别输出独立 `.app` ZIP；Linux 不属于正式交付矩阵。所有打包命令固定 `--publish never`。

Mac 正式组件使用固定摘要验证的官方独立 Node.js 和静态 FFmpeg／FFprobe；不复制 Homebrew 动态依赖。正式报告须为 `bundled-runtime-and-media`，开发目录包不能进入正式交付清单。Node、媒体、SQLite 和 Canvas 在仅保留系统 PATH 的环境验证；媒体源码、许可和固定构建配方随包保存。

## 验收门槛

1. 类型检查、Runtime／SQLite／契约测试和完整浏览器流程通过。
2. `pnpm test:desktop` 在临时工作区启动真实 Electron，验证生产协议、沙箱预加载、IPC／Node、系统凭据、编辑历史、只读制作检查、同身份素材恢复与媒体自动重读、媒体 Range／路径边界、实际 MP4、断连重连及重启草稿。正式包清单必须包含制作检查和素材恢复的原生通过记录。
3. `pnpm test:desktop --packaged` 对本次实际打包应用执行同样的原生检查。
4. 包外执行独立 PDF 解析，本地 HTTP CLI 验证恢复和三比例成片，FFmpeg 实际编码覆盖横屏、竖屏、方形及 4K。
5. Windows 在中文和空格路径验证安装、覆盖、待审任务继续、默认卸载保留以及明确删除范围；Mac 实际解压 ZIP 后验证覆盖、任务继续和移除应用后的数据保留。
6. 明暗主题、自定义主题、代表性窗口、减少动效和焦点行为由生产组件测试；CSS 静态检查核对统一令牌。

[Desktop verification](https://github.com/lazyseacow/video-quickly/actions/workflows/ci.yml) 在 Windows 和两个 Mac 架构执行完整矩阵。每次交付核对对应提交、实际包、清单和安装记录的 SHA-256，失败或缺少报告时不生成成功清单。平台专项及证据见 [Windows 验收](windows-verification.md)和 [Mac 验收](macos-verification.md)。

浏览器中的故意缺失素材与制作检查夹具使用 `preview:e2e` 的同一真实 HTTP、事件和媒体桥接，每条测试拥有独立预览进程、随机端口和临时工作区，复用已构建的客户端。结束时等待执行器与媒体读取器关闭、确认子进程退出后，仅清理该夹具创建且归属未变化的目录；故障文件不会混入其他并行测试的项目封面或素材库。

浏览器测试固定 Playwright 1.64.1，并通过 `pnpm patch` 回移[官方 TCP 随机端口修复 #43605](https://github.com/microsoft/playwright/pull/43605)。该补丁保留原 Chromium 配置，只向已有禁用列表加入 `TcpPortRandomizationWin`，处理 Windows Server 2025 上加载本地资源的 `ERR_NO_BUFFER_SPACE`。升级到包含此修复的稳定版本后，应移除补丁并重跑三平台验收。

## 验收与分发边界

原生专项通过真实预加载和 IPC 调用系统接口，但文件选择、保存与离开确认的用户决定由自动化提供；系统对话框、Finder／Explorer 的实际鼠标交互须在对应桌面人工验证。物理 GPU／驱动长时采样、供应商计费／取消语义和真实视频服务按[外部服务与性能验收](release-validation.md)单独记录。窗口报告保留实际几何与工作区限制，不把低于应用最小窗口尺寸的环境称为完整可见性验证。

安装包当前未签名／公证，不包含自动更新发布流程。应用代码、Electron、构建器及原生绑定的许可证不能替代 Node、Chromium 或 FFmpeg 的组件许可；交付需保留随包许可及媒体来源资料。
