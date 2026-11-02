import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
const staging = join(root, '.generated/icons');
const icons = join(desktop, 'build/icons');
const fromDesktop = createRequire(join(desktop, 'package.json'));
const fromBuilder = createRequire(fromDesktop.resolve('electron-builder/package.json'));
const fromVideo = createRequire(join(root, 'packages/video/package.json'));
// Use the converter supplied by the pinned builder instead of the retired CLI.
const { convertIcon } = fromBuilder('app-builder-lib/out/util/iconConverter.js');
const { createCanvas, loadImage } = fromVideo('@napi-rs/canvas');
const logo = await readFile(join(desktop, 'src/assets/logo.svg'), 'utf8');
const mark = logo.replace(/^<svg[^>]+>\s*|\s*<\/svg>\s*$/g, '');
const artwork = `
  <rect x="4" y="4" width="120" height="120" rx="36" fill="#ffffff"/>
  <g color="#141414" transform="translate(14 16)">${mark}</g>`;
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 128 128">${artwork}
</svg>\n`;
// Match the macOS icon footprint with transparent space around the tile.
const macIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <svg x="100" y="100" width="824" height="824" viewBox="4 4 120 120">${artwork}
  </svg>
</svg>\n`;

await mkdir(staging, { recursive: true });
await mkdir(icons, { recursive: true });
await mkdir(join(desktop, 'public'), { recursive: true });
await writeFile(join(staging, 'app.svg'), appIcon);
await writeFile(join(staging, 'macos.svg'), macIcon);

async function png(source, size, name) {
  const image = await loadImage(Buffer.from(source));
  const canvas = createCanvas(size, size);
  canvas.getContext('2d').drawImage(image, 0, 0, size, size);
  await writeFile(join(icons, name), canvas.toBuffer('image/png'));
}

for (const [size, name] of [[1024, 'icon.png'], [32, '32x32.png'], [128, '128x128.png'], [256, '128x128@2x.png']]) {
  await png(appIcon, size, name);
}
await png(macIcon, 1024, 'dock.png');
await png(logo, 22, 'trayTemplate.png');
await png(logo, 44, 'trayTemplate@2x.png');
for (const format of ['ico', 'icns']) {
  const result = await convertIcon({ sources: [join(staging, format === 'icns' ? 'macos.svg' : 'app.svg')], fallbackSources: [], roots: [root], format, outDir: join(staging, format) });
  if (!result.icons.length) throw new Error(`无法生成 ${format} 应用图标。`);
  await copyFile(result.icons[0].file, join(icons, `icon.${format}`));
}
await writeFile(join(desktop, 'public/favicon.svg'), appIcon);
process.stdout.write('已更新应用、托盘和浏览器图标。\n');
