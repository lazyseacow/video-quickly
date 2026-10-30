# 真实服务与长时媒体验收

此文档补充自动回归的环境边界。服务联调、浏览器长时播放和 Windows 安装后的人工路径分别保存证据；其中一项通过不能替代另外两项。现有平台、Node／pnpm 和媒体工具版本以仓库配置为准。

## 本轮证据状态

2026-10-30 本轮在 macOS arm64 完成以下本地验证，真实供应商与 Windows 实机验收继续单独记录。

| 范围 | 已取得的证据 | 仍需完成 |
| --- | --- | --- |
| 联调工具与恢复 | 配置／恢复纯测试 7 项及脚本类型检查通过；完整本地 HTTP CLI 自测通过，保留原运行、恢复丢失的应用确认，三比例各 30 秒 MP4 | 已配置供应商的实际调用、费用与人工成片审阅 |
| 多独立源播放 | 12 个独立 1080p 源、200 镜头；15 秒短测及 300 秒长测通过，长测实际呈现全部 12 源并观察到逐源运动 | Windows 原生 WebView2、窗口进程内存及 GPU 采样 |
| 本地媒体导出 | `pnpm test:media -- --4k` 四组通过，涵盖横屏 30 fps、竖屏 29.97 fps、方形 25 fps 音视频及 4K 24 fps | 对应交付提交的 Windows 运行结果与系统播放器人工检查 |
| Windows 交付 | 现有 CI、隔离安装脚本及人工矩阵已准备；历史提交结果见 Windows 文档 | 包含本轮全部变更的远程 CI、安装记录及原生人工矩阵 |

本轮只读检查的开发工作区模型连接数为 0，未发现本机独立的原生工作区数据库。实际服务验收前，执行人仍需指定可调用的服务／模型、适用参数、凭据环境变量、费用上限和重试范围。工具不实现金额硬限额；预计逻辑提交数不能用作费用上限，应按服务端可用的预算设置及人工分阶段审阅执行。

## 真实模型成片

`scripts/real-service-smoke.ts` 复用生产 Runtime、活动回执、文本／媒体适配器、字幕识别和批量导出，不启动替代模型服务。它只在新建的验收输出目录内写工作区，不读取日常项目或系统凭据库。

配置文件由执行人放在仓库之外，包含 `title`、`brief` 和 `roles`。角色为 `text`、`image`、`tts`、`video`、`asr`；每项包含 `model`（与应用模型配置相同的协议、地址、型号、能力及参数）和可选 `secretEnv`（凭据环境变量名）。例如一个角色的配置如下，其余四项按实际服务补齐：

```json
{
  "roles": {
    "text": {
      "secretEnv": "VQ_TEXT_SECRET",
      "model": {
        "provider": "openai-compatible",
        "baseUrl": "https://example.invalid/v1",
        "model": "YOUR_TEXT_MODEL_ID",
        "capabilities": ["text"]
      }
    }
  }
}
```

示例只解释结构，不是完整可运行配置。音色、视频时长、图片尺寸、识别格式等参数应按所接服务填写；脚本使用生产契约校验，不能通过在配置中内嵌 API Key 或认证头绕过凭据传递。声明的凭据环境变量为空时，执行会在提交前停止。

先检查配置，仅报告地址、能力与凭据是否可用：

```powershell
pnpm exec tsx scripts/real-service-smoke.ts --config "D:\验收配置\services.json"
```

确认服务、计费和输出位置后显式执行：

```powershell
pnpm exec tsx scripts/real-service-smoke.ts --config "D:\验收配置\services.json" --execute --output "D:\验收结果\service-run-001"
```

首次执行的输出目录必须不存在，其父目录应已创建。工具建立三个约十秒的镜头，依次执行真实脚本、图片、配音和视频，逐阶段确认已保存的实际产物后应用；随后对三个真实配音执行带时间戳的识别，再导出横屏、竖屏和方形 MP4。逻辑上预计一次脚本和每镜头四项媒体／识别工作；服务轮询、供应商切分及实际计费以服务端为准，此数量不是账单上限。

`evidence.json` 记录配置摘要、实际运行 ID、阶段状态、活动计数、批次、输出视频摘要和探测结果。状态 `passed` 仅表示上述技术检查通过；仍需人工检查科学表述、画面、声音、字幕与引用。凭据只保存在进程内存，失败信息会按已配置的秘密值脱敏。

需要分阶段审阅时，可追加 `--stop-after script`，也支持 `assets`、`voice`、`animation` 或 `asr`。工具在该阶段结果保存并应用后记录 `awaiting_review`，不提交后续模型工作；审阅后移除该选项并用同目录 `--resume` 继续。技术验收不会自动把资料或事实主张标记为已核验。

失败或中断时保留原工作区及回执。显式追加 `--resume`，继续同一目录、配置和运行：

```powershell
pnpm exec tsx scripts/real-service-smoke.ts --config "D:\验收配置\services.json" --execute --resume --output "D:\验收结果\service-run-001"
```

恢复会分页核对已经提交的阶段运行，丢失开始回执时不创建另一运行；应用使用稳定的 `applicationId` 与原修订，同事务回执防止丢失应用结果后重复写入。已完成的阶段直接保留，导出继续同一批次并保留成功项。运行对应的凭据引用只从相同配置声明的环境变量重新绑定，模型连接或已确认项目有后续修改时停止推进。

外部提交结果未知时，`--resume` 仍停下等待核对，不自动再次 POST；可通过应用打开该隔离工作区，核对服务端任务和原回执后再继续。明确失败阶段的 `--resume` 是用户请求对原运行重试，并不证明服务端恰好一次计费。不要把新建另一验收目录视为原任务恢复。

验收前还需按真实服务记录超时、限流、取消、已有远端任务查询恢复和用量。当前本地 HTTP 协议测试覆盖这些分支的实现；真实供应商的相同行为必须保留单独证据。

工具自身的端到端回归可用 `pnpm exec tsx scripts/check-real-service-cli.ts <不存在的临时目录>` 单独运行。它使用本地 HTTP 边界和真实 FFmpeg 媒体，先停在脚本审阅，再模拟应用回执丢失后恢复原运行，检查十三次逻辑提交、原脚本仅一次和三种真实 MP4；结果明确标记 `cloudServicesVerified: false`。这项回归不能计入真实供应商联调通过。

2026-10-30 完整自测的 `fixture-check.json` 已记录 `status: passed`、`originalRunRetained: true`、`applicationAcknowledgementRecovered: true`。本地 HTTP 请求为脚本 1 次、图片 3 次、配音 3 次、视频 3 次、识别 3 次；输出为 640×360、360×640 和 480×480，探测时长均为 30 秒并保存 SHA-256。证据位于 `/tmp/vq-real-service-cli-fixture-20261030-002/fixture-check.json` 及其 `run/evidence.json`，其 `cloudServicesVerified` 明确为 `false`。

另一个先在导出阶段失败的隔离目录，在修复本机外部 Docker FFmpeg 包装器的 `/private/tmp` 挂载后，使用原目录 `--resume` 完成三比例导出。恢复时本地模型 HTTP 服务已关闭，七个模型／识别运行仍沿用原回执，证明已完成模型阶段无需再次提交；它不证明真实供应商的重试或计费语义。证据为 `/tmp/vq-real-service-cli-fixture-20261030/run/evidence.json`。这些 `/tmp` 文件是本次机器的临时验收产物，交付归档时需随报告保存，不能把路径本身当作持久发布附件。

## 多独立媒体与长时播放

现有 `media-performance.spec.ts` 保留单个真实源的 50／200 镜头对照。新增 `media-soak.spec.ts` 使用十二个独立编码、不同 SHA-256 的 1080p H.264 文件，组成 200 镜头，覆盖连续源替换以及离屏缩略图回收。

该测量只在显式设置时注册，不增加默认回归中的跳过项。先运行短测验证环境，再执行五分钟验收；两者证据不可混称：

```powershell
$env:VIDEO_QUICKLY_SOAK_SECONDS = "15"
pnpm test:e2e tests/e2e/media-soak.spec.ts --workers=1
$env:VIDEO_QUICKLY_SOAK_SECONDS = "300"
pnpm test:e2e tests/e2e/media-soak.spec.ts --workers=1
Remove-Item Env:VIDEO_QUICKLY_SOAK_SECONDS
```

环境变量接受 15–300 的整数。测量关闭 trace，避免每帧录制改变被测负载；普通功能回归仍保留 trace 和像素断言。输出为 Playwright 产物目录中的 `independent-media-soak.json`，包含真实文件数量／不同哈希数量、机器与浏览器、播放时间、逐段解码／掉帧计数、JS 堆、创建的媒体播放器、最大活跃视频元素及所有控制台／媒体错误。混音准备和轮询的真实任务状态也保留，等待失败时可区分排队与处理失败。

每个源使用不同背景和真实运动图案。采样通过实际视频帧回调记录呈现帧与媒体时间，并比较主 Canvas 和当前原生解码源像素；实际编码／颜色管理后的源作为参考，不把名义 RGB 当作 H.264 解码真值。五分钟运行要求全部十二个独立源都被呈现，且各源运动区域在 Canvas 中发生变化；十五秒短测至少覆盖多个源。持续播放时还检查节目时间推进和带源视频元素不超过主预览加两路取帧的上限；结束后定位第 200 镜头验证回收与重新读取。

每次观测只挂接约 300 毫秒的视频帧回调，观测之间间隔约 650 毫秒，另有 CDP 与页面等待开销；挂接前及源切换期间的帧不在该窗口计数中。源切换还会结束旧视频元素的寿命，因此累计回调数不能除以整段播放时长来计算 FPS，也不能据此宣称固定帧率。原始每个窗口的媒体时间与逐源样本保留在证据文件中。

Chromium 堆不等于进程私有内存或 GPU 显存；该工具明确记录 `nativeGpuMeasured: false`。原生 WebView2／GPU 还需在真实 Windows 设备采集。列表虚拟化、代理媒体等实现应由这些测量中的实际瓶颈决定。

2026-10-30 的本机实测已通过十五秒环境短测和完整三百秒测量：Apple M4、16 GiB、Node 24.22.1、Chromium 156.0.8078.4 headless、trace 关闭。长测实际呈现全部十二个源，每源 Canvas 运动区域得到 12–16 种指纹，观测窗口累计 1837 个视频帧回调，266 次采样，最大存活带源视频为 1，控制台与媒体错误为零；结束后第 200 镜头重新读取通过。节目首末采样相隔约 299 秒，最后采样在开始后约 300.1 秒。

该次 JS 堆采样约从 13.87 MiB 到 13.06 MiB。CDP 对象查询含观测与垃圾回收影响，不能把此数值当作未插桩峰值、进程内存或原生 GPU 结论；累计创建的 162 个播放器包含正常镜头替换，也不等于同时存活数。真实 Windows 原生与 GPU 验收仍保留。

本次长测原始样本为 `/tmp/vq-independent-soak-300/media-soak-plays-200-shots-61be9-ds-sustained-resource-usage/independent-media-soak.json`，同目录保存结束后第 200 镜头的截图；Playwright 汇总为 `/tmp/vq-independent-soak-300.json`。15 秒短测汇总为 `/tmp/vq-independent-soak-15-calibrated.json`，实际覆盖 8 个源。长测没有使用真实供应商，也未测量 Windows 原生 GPU；没有从此次数据中发现必须新增列表虚拟化或代理媒体的依据。

同日当前代码的工作区补测位于 `/tmp/vq-final-workspace-benchmark.json`：200 镜头、1000 素材、200 运行及 20000 事件下，项目读取 P95 为 2.74 毫秒／485728 字节，未变更刷新 P95 为 0.17 毫秒／322 字节，编辑命令 P95 为 0.11 毫秒、合并为 1 步撤销。该脚本还执行旧式全快照等工作，`heapAfterMiB: 100.73` 是整个脚本负载后的堆，不能当作编辑命令的增量内存，也不代表原生窗口内存。四组独立媒体导出的尺寸、时长、帧率和音轨探测保存在 `.generated/render-smoke/results.json`；这些小样与 30 秒 CLI 自测分开记录。

## Windows 联合验收

继续执行 [Windows 自动安装与人工矩阵](windows-verification.md)。`install-smoke.ps1` 和 `installed-runtime-smoke.mjs` 只允许隔离的 GitHub Actions Windows 账号，不能在日常用户工作区绕过环境保护。

每个交付提交应关联其自身的 CI、浏览器报告、四组实际导出和安装清单，并在真实桌面补充系统选择器、凭据重启、目录定位、执行组件异常退出／重连、跨版本升级及系统播放器检查。安装包签名和更新分发有各自的交付状态。

## 完成判定

本轮合并代码已通过完整工作区类型检查和构建，以及 585／585 项自动测试，包含仓库外完整打包组件的中英文 PDF 解析，零跳过。本机 FFmpeg 通过容器运行，完整测试使用 `pnpm test --maxWorkers=2`，保留原超时和业务断言，避免容器并发争用；原始结果为 `/tmp/vq-final-unit-bounded.json`。独立打包 stdio 验收另覆盖两层子流程逐次审阅与重启、两镜头原生 Send 并行及应用回执重用、首请求失败后阻止排队镜头与未知提交防重；其证据为 `/var/folders/3d/l2gcznsn6cgdwr09q4vv_zrw0000gn/T/vq-packaged-native-review-pQMj1j/evidence.json`。合并后的 206／206 条浏览器流程通过，零跳过／重试，耗时约 6.8 分钟；报告为 `/tmp/vq-final-browser-results.json`，截图和 trace 目录为 `/tmp/vq-final-browser-artifacts`。推送后的 Windows CI 结果以对应提交的 Actions 为准。

| 范围 | 必须具备的证据 | 本轮状态 |
| --- | --- | --- |
| 真实模型闭环 | 已配置服务的实际运行／回执、真实图音视频和识别结果、三比例探测、人工成片审阅；协议夹具不代替真实供应商 | 工具本地验收通过；等待真实连接、费用上限及实际执行 |
| 多独立源长时播放 | 300 秒配置实际完成的测量文件、十二个不同文件哈希、连续播放与回收断言；15 秒环境短测不算五分钟验收 | 本机 Chromium 300 秒通过；原生性能另验 |
| Windows 联合路径 | 对应提交的 Windows CI 与安装记录，加真实设备人工矩阵及 GPU／窗口采样；macOS 或 Chromium 结果不代替原生检查 | 本轮远程 CI 与真实 Windows 设备验收待完成 |

工具代码和纯配置测试通过，只能证明验收准备可用。缺少可用服务、凭据或 Windows 设备时，相应范围保留为未验收，不生成成功记录。
