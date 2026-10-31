import { execFileSync } from 'node:child_process';
import { appendFile, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertDarwinBinarySelfContained } from './node-portability.mjs';
import { sha256File, verifiedDownload } from './verified-download.mjs';

export async function prepareMacosMedia(root) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('macOS 媒体组件仅支持 arm64 或 x64 原生构建');
  const manifest = JSON.parse(await readFile(join(root, 'scripts/macos-media-manifest.json'), 'utf8'));
  const build = manifest[process.arch], tools = join(root, '.tools'), media = join(tools, build.directory), bin = join(media, 'bin');
  await mkdir(bin, { recursive: true });
  const binaries = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const specification = { url: `${build.baseUrl}${name}.zip`, sha256: build[name].sha256 };
    const archive = await verifiedDownload(specification, join(tools, `${build.directory}-${name}.zip`));
    const entries = execFileSync('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
    if (entries.length !== 1 || entries[0] !== name) throw new Error('媒体归档包含预期二进制以外的文件');
    execFileSync('/usr/bin/unzip', ['-q', '-o', '-j', archive, '-d', bin]);
    const executable = join(bin, name); await chmod(executable, 0o755);
    if (await sha256File(executable) !== build[name].binarySha256) throw new Error('媒体实际二进制摘要不匹配');
    const libraries = execFileSync('/usr/bin/otool', ['-L', executable], { encoding: 'utf8' });
    assertDarwinBinarySelfContained(libraries, name);
    const version = execFileSync(executable, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!version.startsWith(`${name} version ${manifest.version}-`) || version.includes('--enable-nonfree')) throw new Error('媒体实际版本或可分发许可配置不匹配');
    for (const required of ['--enable-gpl', '--enable-version3', '--enable-libass', '--enable-libx264', '--enable-libfreetype', '--enable-libharfbuzz']) if (!version.includes(required)) throw new Error(`媒体组件缺少制作能力：${required}`);
    const license = execFileSync(executable, ['-L'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!license.includes('GNU General Public License') || !license.includes('version 3')) throw new Error('媒体二进制未声明预期 GPLv3 许可');
    const target = execFileSync('/usr/bin/lipo', ['-archs', executable], { encoding: 'utf8' }).trim();
    if (target !== (process.arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error('媒体二进制 CPU 架构不匹配');
    const minimum = execFileSync('/usr/bin/vtool', ['-show-build', executable], { encoding: 'utf8' });
    binaries[name] = { ...specification, binarySha256: await sha256File(executable), version: version.split('\n')[0], libraries, minimum, license };
    await writeFile(join(media, `${name}-version.txt`), version);
    await writeFile(join(media, `${name}-LICENSE.txt`), license);
  }
  const source = join(media, 'source'); await mkdir(source, { recursive: true });
  for (const resource of manifest.supportFiles) {
    const downloaded = await verifiedDownload(resource, join(tools, 'mac-media-source', resource.name));
    await copyFile(downloaded, join(source, resource.name));
    if (resource.name === 'COPYING.GPLv3') await copyFile(downloaded, join(media, 'LICENSE.txt'));
  }
  await writeFile(join(media, 'provenance.json'), JSON.stringify({ version: manifest.version, license: manifest.license, platform: 'darwin', architecture: process.arch, source: manifest.source, correspondingSource: manifest.correspondingSource, build: build.baseUrl, binaries, sourceFiles: manifest.supportFiles, verified: true }, null, 2));
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `VIDEO_QUICKLY_MEDIA_DIR=${media}\nVIDEO_QUICKLY_FFMPEG=${join(bin, 'ffmpeg')}\nVIDEO_QUICKLY_FFPROBE=${join(bin, 'ffprobe')}\n`);
  console.log(`已校验 macOS ${process.arch} 静态媒体组件：${media}`);
  return media;
}
