import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { cp } from 'node:fs/promises';

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
await cp(resolve(root, 'packages/integrations/src/pdf-process.mjs'), resolve(root, 'packages/runtime/dist/pdf-process.mjs'));
