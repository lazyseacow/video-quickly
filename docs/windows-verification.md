# Windows Electron 交付与恢复验收

本文件描述当前 Electron 路线。此前 Tauri 的安装及跨版本报告属于历史证据，不能作为 Electron 当前版本通过记录；本轮按用户明确要求不实施旧壳数据迁移。macOS 两架构的正式包另见 [macOS 验收](macos-verification.md)。架构与功能门槛见 [Electron 桌面实现与验收](electron-migration.md)。

## 自动检查

`Desktop verification` 工作流的 Windows job在隔离 `windows-2025` 运行器执行锁定依赖、类型检查、完整自动测试、浏览器流程、本地 HTTP CLI 恢复、四组实际媒体导出、Electron 构建、独立打包 PDF、真实 Electron 应用和安装卸载验收。Node 与 pnpm 版本由 `.node-version` 和根 `package.json` 固定；Electron 与构建器精确版本在桌面包清单及锁文件中固定。无需 Rust 或系统 WebView。

`pnpm prepare:media` 按 `scripts/media-manifest.json` 下载、核对 FFmpeg 来源及 SHA-256。许可、来源和 Node 版本随执行组件归档。Electron 产物位于 `.generated/electron-release`；命令使用 `--publish never`，不发布 Release。

`pnpm test:desktop --packaged` 在独立临时工作区启动本次实际目录包，验证沙箱／预加载、真实 IPC／Node、编辑历史、MP4 导出、媒体 Range 与读取边界、失联重连和重启草稿。报告为 `.generated/electron-results.json`，截图／失败证据在 `.generated/electron-artifacts`。发布清单只在所有要求的报告成功且非空时生成。

## 隔离安装验收

`scripts/install-smoke.ps1` 仅允许在隔离 Windows Actions 账号执行；它拒绝已有 `VideoQuickly-Electron` 数据和验收安装目录。它会：

1. 在含中文／空格目录安装本次 NSIS 包，核对实际 EXE 产品版本。
2. 使用安装包自带的 Node 创建真实项目、素材和待审检查点。
3. 重复安装本包，启动已安装的 Electron，验证默认数据目录、媒体组件、真实预加载通信及关闭后执行组件退出。
4. 继续原待审任务并确认已完成活动复用，实际导出 MP4，再次覆盖安装并复核窗口启动。
5. 在所有执行器退出后记录 DB、存在的 WAL 和夹具素材的长度／摘要；默认静默卸载后核对内容未变，不打开 SQLite 改变 WAL。
6. 重装后明确传入 `--delete-app-data` 卸载，核对新 Electron 工作区被移除。交互卸载界面默认不选删除，只有用户明确勾选才删除。

数据选择仅针对新的 Electron 数据目录，不触碰旧 Tauri 目录。系统凭据不写入可提交文件，安装运行夹具不调用真实供应商。

## 对应提交核对

push 到 `main` 或 PR 自动运行该工作流；`workflow_dispatch` 可补跑审核后的已推送提交。必须核对 Actions `headSha` 与目标提交相同，归档本次自动测试、浏览器、Electron、四组编码、PDF、安装与发布清单，不能沿用其他提交的绿色状态。

## 人工矩阵

| 项目 | 验收要求 | 自动化边界 |
| --- | --- | --- |
| 系统选择器 | 图片／视频／音频／Skill／备份路径和取消，中文路径 | 原生专项替代用户选择结果，实际系统对话框鼠标交互另验 |
| 系统凭据 | 新建、替换、删除、重启后使用，诊断不泄密 | 使用独立随机测试引用，绝不读日常密钥 |
| 原生恢复 | 任务期间终止执行组件，草稿保留，重连不重提生成 | 专项与真实进程回归覆盖；安装后联合操作另验 |
| 卸载选择 | 默认保留、明确删除 | CI 验证静默参数；交互 checkbox 需人工检查 |
| 媒体播放 | 系统播放器正常打开输出，音画字幕完整 | 自动编码／探测不能代替人工观片 |
| 原生性能 | 12 个独立 1080p 源、200 镜头、300 秒，记录 GPU／驱动／内存／掉帧 | 浏览器 headless 或 macOS 数据不能冒充 Windows GPU 结果 |

本机为 macOS，Windows 原生／安装结果以对应提交的 Windows CI 为准；没有实机或模型时保留相关未验收项。现有数据模型、Schema 迁移、Source／Plan、备份与回执恢复约束继续由 Runtime 的真实测试覆盖，见 [持久化执行](durable-execution.md)。
