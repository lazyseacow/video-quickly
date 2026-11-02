import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  entryPoints: [resolve(root, 'packages/runtime/src/main.ts')],
  outfile: resolve(root, 'packages/runtime/dist/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['better-sqlite3', '@napi-rs/canvas', 'pdf-parse'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  sourcemap: true,
  plugins: [{
    name: 'workspace-contracts',
    setup(builder) {
      builder.onResolve({ filter: /^@video-quickly\// }, args => {
        const [name, entry = 'index'] = args.path.replace('@video-quickly/', '').split('/');
        return { path: resolve(root, `packages/${name}/src/${entry}.ts`) };
      });
    },
  }],
});

// The desktop shell uses the same file-only logger as the standalone runtime.
// Bundle its Node entry so production never depends on workspace source paths.
await build({
  entryPoints: [resolve(root, 'packages/runtime/src/logging.ts')],
  outfile: resolve(root, 'apps/desktop/electron/logging.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
