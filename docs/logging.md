# 运行日志规范与排查

自动运行日志记录应用和任务的技术状态。运行事件、活动账本、检查点和用户主动导出的运行诊断分别保存业务与恢复证据；文件日志用于定位问题，提交结果和可重试状态以持久化记录为准。

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
| `shotId`, `modelId`, `assetId` | 镜头、模型连接和产物关联标识；自定义编号同样使用稳定哈希 |
| `nodeKind`, `provider`, `shotCount` | 固定节点类型、服务协议和当前媒体步骤的镜头数量 |
| `phase`, `queueMs`, `byteSize`, `pollCount` | 当前处理环节、模型队列等待毫秒数、响应或素材字节数、轮询次数 |
| `retryCount`, `retryDelayMs` | 查询连续失败后的自动重试次数与实际等待毫秒数；查询恢复成功后连续失败计数清零 |
| `requestPhase` | 文本模型请求最后进入的环节：`prepare` 准备、`send` 发送、`headers` HTTP 状态检查、`read` 读取正文、`parse` 解析 JSON、`validate` 校验模型结果 |
| `status`, `previousStatus`, `reason`, `error` | 状态、固定原因码和安全错误分类 |

`debug` 用于查询起止、每次模型轮询请求、活动结果复用和细粒度状态；`info` 用于启动关闭、写操作起止、节点执行、模型请求和镜头处理阶段；`warn` 用于取消、协议拒绝、断连、结果不明和恢复；`error` 用于执行失败、超时、崩溃和清理失败。默认阈值为 `info`，查询轮询不会持续刷盘。写操作的 `rpc.started` 可定位尚未返回的请求，`rpc.completed` 补充新建项目或运行编号；失败记录继承请求中已有的关联编号。成功写操作主要由执行器记录，桌面只在 debug 级别记录 RPC 成功。

默认日志包含以下细节，无需提前开启 debug：

- `node.execution_started/completed/failed/canceled`：包括子流程在内的节点执行起止和耗时，覆盖模型校验、凭据读取和媒体预检等活动提交前的失败。原有 `node.started/completed` 是业务流程事件；执行完成与图中的推进分别记录。
- `provider.request_started/completed/failed`：普通文本模型实际请求的起止和耗时，失败时包含 `requestPhase`，可区分发送失败、响应读取中断、JSON 解析错误和空结果。自定义 provider 可通过 `onRequestPhase` 补充阶段；未报告时省略此字段。研究结果复用时不记录新的模型请求。Agent 内部工具调用仍以活动账本与运行诊断为准。
- `media.queued/started/completed/failed/canceled`：每个待生成镜头的排队、执行和结果；`queueMs` 与执行 `durationMs` 分开记录。失败中的 `phase` 表示最后进入的环节。
- `media.request_started/completed/failed`：提交请求的 HTTP 状态、响应字节数和耗时；每次轮询请求的起止只在 debug 记录，失败仍自动记录。HTTP 错误保留数值状态，不保存响应体。
- `media.poll_started/completed`、`media.download_started/completed`、`media.validation_started/completed`：远端查询、素材落盘与校验的分段记录；查询完成包含轮询次数，校验完成包含产物编号和大小。
- `media.poll_retry_scheduled`（warn）、`media.poll_recovered`（info）：已提交任务的进度查询遇到临时连接错误、超时或 HTTP 408/429/500/502/503/504 时自动退避重试；记录错误码、状态、重试次数、等待间隔及恢复成功。重试沿用原远端任务，受同一查询时限和取消信号约束，不重复提交生成请求。
- `media.receipt_loaded`、`media.reused`：恢复时读取的本地回执状态与已完成素材复用，不记录远端任务编号或下载地址。恢复下载不重复提交生成请求。
- `media.render_started/completed`：本地导出渲染的起止和耗时，产物整理及保存结果由节点日志补充。

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

文件日志仅接受明确允许的元数据字段。禁止传入请求参数、返回值、提示词、用户文案、模型对象、凭据、请求头、供应商响应体、完整 URL、素材路径和原始子进程输出。异常只记录内置/已知错误类型、允许列表内的系统错误码、HTTP 状态，以及文件名哈希和行列坐标。`cause` 和聚合异常 `errors` 递归使用相同规则，最多向下三层，每层聚合最多三项，跳过循环引用；可区分 DNS、连接、超时和证书错误，不保存任意异常消息或原始 cause 内容。脱敏边界不依赖识别某个密钥前缀。服务协议、节点类型和处理环节也只接受固定枚举值。

UUID 和内建节点编号可直接关联；用户自定义标识符使用稳定的 `sha256:` 短哈希，因此同一编号仍可在不同记录中检索。RPC 名称只允许有限的内部词汇组合，未知名称记作 `unknown`。这些日志减少自动收集的内容，分享前仍应检查项目关联信息。

新增接入时复用 `src/packages/runtime/src/logging.ts`，事件名采用固定的 `组件.动作` 字符串，使用 `logger.child()` 添加上下文，不拼接用户输入。错误通过 `logError()` 处理。集成层通过有类型的 `onDiagnostic` 回调提供技术元数据，执行器统一补齐关联上下文并落盘，不从集成层反向依赖执行器。新增元数据字段或操作词时同步更新白名单和隐私回归测试。前端不能导入 Node 日志依赖；Electron 的 `logging.mjs` 由 `scripts/build-runtime.mjs` 从相同源模块生成并打包，不能手工修改。

## 排查顺序

1. 先记录用户操作发生的时间、应用版本和工作区；按 UTC 转换时间，检查当前日志及 `.old.log`。
2. 桌面无法启动或失联时，查 `desktop.start_failed`、`runtime.spawn_failed`、`runtime.disconnected`、`rpc.timeout`、`runtime.exited`；结合 `generation`、`childPid` 区分不同执行器。
3. 请求失败时，按 `requestId` 对照桌面和执行器记录。编号会在新桌面进程中重置，须同时参考时间、会话、进程和代次。默认级别没有成功的查询日志，需要复现细节时开启 debug。
4. 生成失败时，按 `runId` 依次查 `run.execution_started`、`node.execution_*`、`activity.dispatched/completed/failed` 和 `run.failed`；再用 `nodeId`、`shotId` 检索 `provider.request_*` 或 `media.*`，检查最后进入的 `phase`、HTTP 状态及 `error.cause`。只有开始记录时，可判断仍在等待的环节；日志缺失也可能由崩溃或写盘失败造成，需结合进程状态核对。`activity.blocked` 或 `status: unknown` 表示提交结果需核对，不据此自动再次调用供应商。
5. `run.recovered` 说明启动时发现未结束运行；`activity.reused` 表示复用了已提交结果。需要创作输入、步骤输出和更完整上下文时，在应用内主动导出该运行的诊断包。

文本 `TypeError` 先看 `requestPhase` 和 `error.cause.code`；多地址连接失败时还需查看 `error.cause.errors`。`send` 表示响应头尚未返回，不能据此判断服务端是否已接收请求；`read` 表示读取响应正文时失败。

「本次制作」和模型连接检查会把可识别的网络错误、HTTP 状态和无效响应显示为具体原因及处理建议。运行记录保存固定文案，提交结果待核对时同时保留对应状态。供应商原始错误正文、地址和凭据仅按既有脱敏规则处理。

## 实现与验证

文件写入与大小轮转由 `src/packages/runtime/src/logging.ts` 统一封装 electron-log 的独立 Node 入口，固定版本见 [Runtime 包清单](../src/packages/runtime/package.json)。封装关闭默认控制台输出，并替换库内部文件错误通知中的原始异常转发。

回归覆盖 JSON 行格式、级别过滤、大小轮转、受限文件权限、写入失败、嵌套异常脱敏及深度限制、真实 HTTP 429/503、镜头分阶段日志、恢复下载不重提、任务恢复/复用、请求关联、协议隔离和真实执行器退出。`pnpm test:desktop --packaged` 同时检查实际应用包生成的两类日志及夹具凭据排除；Windows 和 macOS 的原生包验收分别执行，不能互相替代。
