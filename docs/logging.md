# 运行日志规范与排查

自动运行日志记录应用和任务的技术状态。项目内原有运行事件、活动账本、检查点和用户主动导出的运行诊断继续保留各自用途；文件日志不能作为提交成功或付费任务是否可重试的依据。

## 位置与保留

日志位于当前工作区的 `logs/` 子目录：

| 环境 | 默认日志目录 |
| --- | --- |
| Windows 桌面 | `%APPDATA%\VideoQuickly-Electron\logs` |
| macOS 桌面 | `~/Library/Application Support/VideoQuickly-Electron/logs` |
| 浏览器开发预览 | 仓库根目录 `.data/development/logs` |
| 浏览器回归预览 | 仓库根目录 `.data/browser-preview/logs`，测试通常覆盖为独立临时目录 |

桌面使用 `VIDEO_QUICKLY_DATA_DIR` 指定工作区；独立执行器使用 `--data-dir` 或 `VIDEO_QUICKLY_DATA`。日志跟随工作区，不使用当前 shell 所在目录。测试与日常工作区隔离。

`desktop.log` 记录 Electron、窗口和执行器连接状态；`runtime.log` 记录 RPC、工作流、节点和活动。每个文件默认超过 5 MiB 后在下一次写入时轮转，只保留一份 `desktop.old.log` / `runtime.old.log`。两类文件及归档合计约 20 MiB，加上边界处的一条日志大小。无需后台清理服务。

写入为同步追加，保证退出前已写出的记录可读。日志目录不可写或磁盘已满时，业务继续按原路径运行，进程仅向 stderr 发出一次 `logging.file_unavailable` 通知。stderr 原始内容不会由桌面转存。此时应先检查剩余空间和目录权限，修复后重启应用。独立执行器的 stdout 始终仅输出 JSON-RPC。

## 格式与级别

每行是独立 JSON 对象，可按行检索、解析，时间统一使用 UTC ISO 8601。基础字段：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 当前格式版本 `1` |
| `time`, `level`, `event` | 时间、级别和稳定事件名称 |
| `component`, `pid`, `runtimeSessionId` | 组件、日志进程编号和本次 logger 会话编号；child logger 继承编号 |
| `requestId`, `method`, `durationMs` | RPC 关联编号、安全操作名和耗时 |
| `generation`, `childPid` | 桌面执行器代次和子进程编号 |
| `runId`, `projectId`, `nodeId`, `activityId` | 任务、项目、节点、活动关联标识 |
| `status`, `previousStatus`, `reason`, `error` | 状态、固定原因码和安全错误分类 |

`debug` 用于请求起止、查询、结果复用和细粒度状态；`info` 用于启动关闭、成功写操作、运行与活动进展；`warn` 用于协议拒绝、断连、结果不明和恢复；`error` 用于执行失败、超时、崩溃和清理失败。默认阈值为 `info`，查询轮询不会持续刷盘。成功写操作主要由执行器记录，桌面只在 debug 级别记录 RPC 成功。

临时开启 debug 后重新启动应用：

```powershell
$env:VIDEO_QUICKLY_LOG_LEVEL='debug'
pnpm dev:desktop
# 排查完毕后恢复默认：
Remove-Item Env:VIDEO_QUICKLY_LOG_LEVEL
```

```sh
VIDEO_QUICKLY_LOG_LEVEL=debug pnpm dev:desktop
```

可选值为 `debug`、`info`、`warn`、`error`；无效值回退到 `info`。浏览器预览同样支持该变量。正式应用需从继承该环境变量的启动方式打开。

## 内容边界与开发约定

文件日志仅接受明确允许的元数据字段。禁止传入请求参数、返回值、提示词、用户文案、模型对象、凭据、请求头、供应商响应体、完整 URL、素材路径和原始子进程输出。异常只记录内置/已知错误类型、系统错误码、HTTP 状态和去目录后的栈位置，不保存任意 `message`、`cause` 或响应体。脱敏边界不依赖识别某个密钥前缀。

UUID 和内建节点编号可直接关联；用户自定义标识符使用稳定的 `sha256:` 短哈希，因此同一编号仍可在不同记录中检索。RPC 名称只允许有限的内部词汇组合，未知名称记作 `unknown`。这些日志减少自动收集的内容，分享前仍应检查项目关联信息。

新增接入时复用 `packages/runtime/src/logging.ts`，事件名采用固定的 `组件.动作` 字符串，使用 `logger.child()` 添加上下文，不拼接用户输入。错误通过 `logError()` 处理。新增元数据字段或操作词时同步更新白名单和隐私回归测试。前端不能导入 Node 日志依赖；Electron 的 `logging.mjs` 由 `scripts/build-runtime.mjs` 从相同源模块生成并打包，不能手工修改。

## 排查顺序

1. 先记录用户操作发生的时间、应用版本和工作区；按 UTC 转换时间，检查当前日志及 `.old.log`。
2. 桌面无法启动或失联时，查 `desktop.start_failed`、`runtime.spawn_failed`、`runtime.disconnected`、`rpc.timeout`、`runtime.exited`；结合 `generation`、`childPid` 区分不同执行器。
3. 请求失败时，按 `requestId` 对照桌面和执行器记录。编号会在新桌面进程中重置，须同时参考时间、会话、进程和代次。默认级别没有成功的查询日志，需要复现细节时开启 debug。
4. 生成失败时，按 `runId` 依次查 `run.execution_started`、节点事件、`activity.dispatched/completed/failed` 和 `run.failed`。`activity.blocked` 或 `status: unknown` 表示提交结果需核对，不据此自动再次调用供应商。
5. `run.recovered` 说明启动时发现未结束运行；`activity.reused` 表示复用了已提交结果。需要创作输入、步骤输出和更完整上下文时，在应用内主动导出该运行的诊断包。

## 方案与验证

采用 MIT 许可、无额外运行时依赖的 [electron-log 5.4.4](https://github.com/megahertz/electron-log) 的独立 Node 入口，复用其[文件写入和大小轮转](https://github.com/megahertz/electron-log/blob/master/docs/transports/file.md)。关闭默认控制台输出，并替换库内部文件错误通知中的原始异常转发。

回归覆盖 JSON 行格式、级别过滤、大小轮转、受限文件权限、写入失败、脱敏、任务恢复/复用、请求关联、协议隔离和真实执行器退出。`pnpm test:desktop --packaged` 同时检查实际应用包生成的两类日志及夹具凭据排除；Windows 和 macOS 的原生包验收分别执行，不能互相替代。
