# macOS 双架构正式交付与验收

正式支持 macOS 13.5 及以上的 Apple Silicon arm64 和 Intel x64。两个架构分别构建 ZIP 内的独立 `.app`，不依赖用户安装 Node、Homebrew 或 FFmpeg。Windows 的既有完整回归与安装门槛继续保留；Linux 尚非正式目标。

## 固定组件与来源

- Node.js 24.22.1：官方 macOS 两架构 tar.gz，固定摘要见 `scripts/node-manifest.json`，与 `.node-version` 保持一致。准备时核对实际架构、版本和动态库依赖；完整 Node 许可随执行组件保存。
- FFmpeg／FFprobe 9.0.2：Martin Riedl 静态发行构建，Apple Silicon 固定 build `1789931890_9.0.2`，Intel 固定 build `1789931006_9.0.2`；四份 ZIP 摘要见 `scripts/macos-media-manifest.json`。归档摘要与发布者提供的 `.sha256` 一致，再解压、核对实际版本／架构、GPLv3 声明、无 `--enable-nonfree`、libass／H.264／FreeType／HarfBuzz 及仅系统动态库依赖。
- 随包 `media/source` 保存 GPL 全文、完整 FFmpeg n9.0.2 源码归档以及上游公开构建配方的固定 commit 快照 `f63b8aab8f5ce1a067da86ba69e34a36a7e217e5`。快照属于发布者公开的配方；实际二进制配置、许可声明和校验值分别记录在 provenance 中，不将配方仓库当前默认版本冒充实际二进制版本。
- Node 的官方 `LC_BUILD_VERSION` 为 13.5；所选 FFmpeg／FFprobe 两架构为 12.0；本机 Electron 45 arm64 主程序／Framework 为 13.0。因此设置 `minimumSystemVersion: 13.5.0`，并让每个原生 CI 检查包内所有 Mach-O（含原生模块）的实际最低要求不能高于该声明。

来源：[Node 24.22.1 校验清单](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt)、[Node 平台支持](https://github.com/nodejs/node/blob/v24.22.1/BUILDING.md)、[Martin Riedl 历史构建](https://ffmpeg.martin-riedl.de/)、[公开构建配方](https://git.martin-riedl.de/ffmpeg/build-script)。固定源不可用或摘要变化时停止，重新核实后再更新清单，不自动切换最新版。

## 本机运行

```sh
pnpm install --frozen-lockfile
pnpm prepare:media
pnpm build:desktop
node scripts/verify-macos-bundle.mjs
pnpm test:desktop --packaged
```

输出：`.generated/electron-release/Video-Quickly-<版本>-macos-<架构>.zip`；独立应用在 `mac-arm64/Video Quickly.app` 或 `mac/Video Quickly.app`。打包命令不发布 Release。

`verify-macos-bundle.mjs` 证明执行组件是普通文件、架构正确、Node／媒体和原生依赖不链接开发机动态库，并在仅保留 `/usr/bin:/bin:/usr/sbin:/sbin` 的环境加载实际 SQLite／Canvas。原生模块的 `LC_ID_DYLIB` 是模块自身身份，不属于外部依赖；由 `otool -D` 单独识别，不以字符串前缀猜测跳过。报告为 `.generated/macos-portability.json`。

## 原生 CI 与安装验证

[GitHub 官方 runner 表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)明确 `macos-15` 为 arm64，`macos-15-intel` 为 Intel x64；工作流启动时再次核对 Node 的实际架构。两个 job 均执行类型、全部自动测试、全部浏览器流程、本地 HTTP 恢复、四组实际编码（含 4K）、生产 ZIP、包内 portability、独立打包 PDF 和真实 Electron 专项。

`scripts/install-macos-smoke.mjs` 只在全新隔离 macOS CI 账号执行，拒绝已有 Electron 数据。它实际解压本次 ZIP、复制到中文／空格路径，创建真实项目、素材和待审检查点；覆盖应用后验证默认工作区、原任务继续和实际导出；移除应用前后比较数据库、WAL 和媒体摘要，证明移除 `.app` 默认保留项目数据。它不自动操作 Finder，不接触旧 Tauri 数据；最后仅清理本次创建的隔离账号数据。

只有本架构所有报告均通过，`collect-macos-artifacts.mjs` 才归档 ZIP、来源／版本／摘要和验收清单。安装后的源版本、CPU 和完整功能验收必须由该次真实报告证明，另一架构或本机开发目录包的成功不能代替。

## 当前交付边界

当前 ZIP／安装器未进行 Developer ID 签名、公证或自动更新发布；这些不由 CI 的功能通过隐含完成。系统对话框的真实鼠标交互、人工观片和物理 GPU／驱动长时采样仍按各自矩阵记录，虚拟 CI 或 macOS 结果不冒充 Windows 实机证据。
