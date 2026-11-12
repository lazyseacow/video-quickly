# 功能现状与开发边界

本文以当前 Electron 实现为准。安装运行见 [README](../README.md)，桌面进程、数据目录和平台约束见 [Electron 架构](electron-desktop.md)。具体版本、测试数量和通过结果由对应提交的锁文件、CI 报告与产物清单确定。

## 已实现功能

| 范围 | 当前能力 | 契约与验证入口 |
| --- | --- | --- |
| 制作设置与进度 | 顶部唯一制作配置入口，逐步填写并最终保存；阶段卡片打开对应步骤记录。运行中独立保存待用配置，失败后从统一入口调整再重做；局部运行保留完整卡片与真实进度，历史分组、模型与提示词按冻结记录展示 | [生成进度](workspace-editing.md#制作指引与生成进度)、`stage-configuration-draft.test.ts`、`workbench-stage-panel.spec.ts`、`workbench-guide-progress.spec.ts`、`workflow-stages.spec.ts` |
| 导航与设置 | 52px 单列图标栏统一项目、资源与工具入口并提供悬停名称；项目列表进入工作台；左下角设置浮层集中提供胶囊外观切换、Token 消耗与使用指南；首次指南按实际操作推进 | [桌面工作区](electron-desktop.md#工作区与持久化)、`workspace-settings.spec.ts`、`getting-started.spec.ts` |
| 桌面与交付 | Windows x64、macOS arm64／x64；沙箱预加载、独立 Node 执行器、系统凭据、原生路径选择、媒体协议、进程退出与重连；独立媒体组件和安装数据保留 | [Electron 架构](electron-desktop.md)、[Windows](windows-verification.md)、[macOS](macos-verification.md) |
| 大项目读取 | 轻量工作区摘要、条件项目详情、服务端分页、后台刷新合并、迟到结果隔离；镜头与轨道按行复用，保持最新操作及全片引用上下文；只为可见缩略图读取真实帧，限制并发与缓存 | [读取与编辑契约](workspace-editing.md#读取契约)、`benchmark:workspace`、`editor-row-rendering.spec.ts`、`media-performance.spec.ts` |
| 编辑与恢复 | 统一增量命令、连续输入合并、最多 50 步撤销／重做、IndexedDB 草稿；保存前意图落盘、保存期间新输入、外部修订冲突与重启恢复 | [编辑与恢复](workspace-editing.md#编辑与恢复)、`project-editing.spec.ts`、`draft-save-ordering.spec.ts` |
| 剪辑与声音 | 多选、成组移动／复制／删除、分割、入出点、吸附；真实波形、字幕编辑、背景音乐及视频原声开关 | [剪辑与声音](workspace-editing.md#镜头剪辑区间)、`clip-editing.spec.ts`、`video-original-audio.spec.ts` |
| 文稿剪辑 | 来源匹配的逐词／句段时间戳、手选区间、真实停顿检测；Source／Plan 同步裁切画面、音频和字幕，恢复当前源窗口 | [文稿与备份](workspace-editing.md#文稿剪辑与源窗口恢复)、`transcript-editing.spec.ts` |
| 模型与候选 | 文本、图片和视频的基本连接；从服务目录选择型号并读取能力；单镜头生成候选、对比、按字段应用、修订与素材保护 | [角色、参数与费用](workspace-editing.md#角色模型参数与费用)、`model-protocols.spec.ts`、`shot-regeneration.spec.ts` |
| 制作前检查 | 「更多」提供手动检查。开始制作前核对本次保存的配置与素材，有阻塞时显示问题步骤和修复入口，通过后直接提交 | [制作前检查](workspace-editing.md#制作前检查)、`project-readiness.spec.ts` |
| 素材恢复 | 当前项目或整个工作区的缺失清单、目录扫描、完整摘要匹配、候选确认、分页批量恢复与取消；保留冻结身份并自动刷新媒体 | [批量素材恢复](workspace-editing.md#批量素材恢复)、`asset-recovery.spec.ts` |
| 创作一致性 | 项目角色池、连续性及人物／场景／道具文字设定；从空分镜自动建立白名单角色绑定，实际发送逐镜头参考图；冻结恢复、候选保护和格式 5 备份 | [角色与创作设定](workspace-editing.md#角色模型参数与费用)、`creative-context.test.ts`、`creative-context-runtime.test.ts`、`creative-context.spec.ts` |
| 角色与费用 | 角色参考图、镜头绑定、价格快照、服务用量与实付登记、任务归档；旧资料数据仅保留兼容，已移除编辑与引用展示 | [工作区功能契约](workspace-editing.md)、`cost-task-archive.spec.ts` |
| 画面与导出 | 流程讲解／对比／数据图模板、字幕样式、系列模板、位置与缩放关键帧曲线；MP4／SRT／分镜导出，多比例冻结批次、部分失败恢复和取消 | [模板与批量导出](workspace-editing.md#科普模板与批量导出)、`template-batch-export.spec.ts`、`keyframe-editing.spec.ts` |
| 自动工作流 | 内置四阶段、按镜头顺序生成、自动接续、失败步骤重试和恢复、策划结果编辑与脱敏诊断。在工作台查看当前进度，从提示词实验查看步骤详情 | [持久化执行契约](durable-execution.md)、`native-video-settings.spec.ts`、`run-step-retry.spec.ts` |
| 提示词实验 | 离线共用编译、独立冻结会话与试运行、单镜头候选、显式应用、模板与片段固定版本、受限变量、实验来源及费用核对 | `prompt-bindings.test.ts`、`prompt-workbench.test.ts`、`prompt-media.test.ts`、`prompt-workbench.spec.ts` |
| 项目原文 | 小说或剧本文字随项目保存，供正式制作使用，重试沿用原任务输入 | `automatic-workflow.test.ts`、`native-video-settings.spec.ts` |
| 项目备份 | 导出项目文档、素材、角色与参考图，格式按项目能力选择 | [持久化执行契约](durable-execution.md)、Runtime 备份回归 |
| 运行日志 | 桌面与执行器分别保存 JSON 行日志，按大小轮转；请求和任务可关联，字段白名单与错误分类控制内容 | [日志规范](logging.md)、`logging.test.ts`、`runtime-logging.test.ts`、`browser-rpc-diagnostics.test.ts` |

表中单元测试位于 `tests`，浏览器流程位于 `tests/e2e`；Runtime、契约及媒体回归覆盖各自的数据与副作用边界。模型连接列表、协议夹具或自动化通过不能代替某个供应商的实际可用性和计费验证。

## 界面规范

界面遵循 [DESIGN.md](../DESIGN.md) 的 Mobbin 规范。基础色板、主题语义、排版、间距、圆角与动效统一来自 `src/renderer/design-tokens.css`；公共控件复用 `Primitives.tsx`。素材、字幕和用户场景颜色属于内容数据，媒体坐标与时间轴几何保留业务语义。

Windows 和 macOS 共享同一套组件，通过 `lib/desktop.ts` 适配快捷键及路径提示。表单保留原生文字选择与撤销，工作台命令历史管理项目编辑。CSS 与 GSAP 共用时长角色，覆盖减少动效、焦点恢复、快速切换及卸载清理；页面和费用表格采用平面层次，避免依赖装饰性玻璃效果表达信息。

## 持续验收

每次相关功能变更先运行覆盖其真实行为的回归，再执行仓库规定的类型、测试和构建。涉及桌面桥接、媒体或打包时，Windows 与两个 Mac 架构分别验证实际包；不得用浏览器预览或其他架构的结果代替。

完整交付包括对应提交的测试报告、实际媒体探测、原生报告、安装与数据保留记录、包摘要及组件许可。[Desktop verification](https://github.com/lazyseacow/video-quickly/actions/workflows/ci.yml) 执行这些门槛，测试数量随实现变化，以当次报告为准。

## 外部验收与发布边界

- 系统文件选择器、Finder／Explorer、交互式卸载选项和人工观片在实际桌面验证。
- 物理 GPU／驱动、窗口进程内存及多独立源长时播放按实测环境保存证据，不把 Chromium 堆或虚拟 CI 当作物理 GPU 结论。
- 真实供应商的可用模型、用量、实付、取消和远端任务恢复需独立连接与授权；未知提交不自动再次 POST。
- 当前构建不发布 Release，安装包未签名／公证，签名和更新分发需独立配置。

验收方法与证据要求见[外部服务与性能验收](release-validation.md)。后续功能扩展应由实际内容需求或可重复瓶颈驱动，不将列表虚拟化、代理媒体或更多模板预先视为当前缺陷。
