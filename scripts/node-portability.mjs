/** Reject copied Node executables that still require a developer installation. */
export function assertDarwinNodeSelfContained(output) {
  const libraries = output.split('\n').flatMap(line => {
    const match = /^\s+(.+?)\s+\(compatibility version\b/.exec(line);
    return match ? [match[1]] : [];
  });
  if (!libraries.length) throw new Error('无法核对 macOS 发布用 Node 的动态库依赖。');
  if (libraries.some(path => !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'))) {
    throw new Error('macOS 发布用 Node 仍依赖开发机动态库，不能生成可分发组件。请使用官方独立 Node.js 24 运行打包命令；Homebrew Node 可继续用于 pnpm dev:desktop。');
  }
}
