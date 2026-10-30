import { cp, mkdir, readdir, rename, rm, stat, writeFile, readFile, realpath, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const generated=join(root,'.generated');
const sidecar=join(generated,'sidecar');
const stage=join(generated,`sidecar-stage-${Date.now()}`);
const development=process.argv.includes('--development');
await mkdir(generated,{recursive:true});
const runtime=join(root,'packages/runtime/dist/main.mjs');
await stat(runtime);
await mkdir(stage,{recursive:true});
const fromRuntime=createRequire(join(root,'packages/runtime/package.json'));
const fromVideo=createRequire(join(root,'packages/video/package.json'));
const fromIntegrations=createRequire(join(root,'packages/integrations/package.json'));
async function copyModule(name,from){
  let source;
  try{source=dirname(await realpath(from.resolve(`${name}/package.json`)));}
  catch(error){
    if(error?.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw error;
    let candidate=dirname(await realpath(from.resolve(name)));
    for(;;){
      const metadata=await readFile(join(candidate,'package.json'),'utf8').then(JSON.parse,()=>undefined);
      if(metadata?.name===name){source=candidate;break;}
      const parent=dirname(candidate);if(parent===candidate)throw new Error(`无法定位依赖包 ${name}`);candidate=parent;
    }
  }
  await cp(source,join(stage,'node_modules',name),{recursive:true,dereference:true,filter:path=>!path.includes(`${source}\\node_modules`)&&!path.includes(`${source}/node_modules`)});
  return createRequire(join(source,'package.json'));
}
const fromSqlite=await copyModule('better-sqlite3',fromRuntime);
const fromBindings=await copyModule('bindings',fromSqlite);
await copyModule('file-uri-to-path',fromBindings);
const fromCanvas=await copyModule('@napi-rs/canvas',fromVideo);
const canvasBinary=process.platform==='win32'?`@napi-rs/canvas-win32-${process.arch}-msvc`:process.platform==='darwin'?`@napi-rs/canvas-darwin-${process.arch}`:`@napi-rs/canvas-linux-${process.arch}-gnu`;
await copyModule(canvasBinary,fromCanvas);
// Keep PDF.js workers, standard fonts and wasm beside the external parser package.
const fromPdf=await copyModule('pdf-parse',fromIntegrations);
await copyModule('pdfjs-dist',fromPdf);
await writeFile(join(stage,'package.json'),JSON.stringify({name:'video-quickly-runtime',version:'0.1.0',private:true,type:'module'}));
await cp(runtime,join(stage,'runtime.mjs'));
// Homebrew Node depends on libraries beside its original executable.
// A development link preserves those paths; release bundles still copy Node.
if(development&&process.platform!=='win32')await symlink(process.execPath,join(stage,'node'));
else await cp(process.execPath,join(stage,process.platform==='win32'?'node.exe':'node'));
const mediaRoot=process.env.VIDEO_QUICKLY_MEDIA_DIR;
if(mediaRoot){
  const mediaSource=resolve(mediaRoot);
  const hasBin=await stat(join(mediaSource,'bin')).then(value=>value.isDirectory(),()=>false);
  await cp(hasBin?join(mediaSource,'bin'):mediaSource,join(stage,'media'),{recursive:true});
  if(hasBin)await cp(join(mediaSource,'LICENSE.txt'),join(stage,'media','LICENSE-FFmpeg.txt'));
  await cp(join(mediaSource,'provenance.json'),join(stage,'media','provenance.json'));
}
else if(process.platform==='win32'){
  const tools=join(root,'.tools');
  const entries=await readdir(tools,{withFileTypes:true}).catch(()=>[]);
  const mediaLock=JSON.parse(await readFile(join(root,'scripts','media-manifest.json'),'utf8'));
  const portable=entries.find(entry=>entry.isDirectory()&&entry.name===mediaLock.directory)??entries.find(entry=>entry.isDirectory()&&entry.name.includes('ffmpeg')&&entry.name.includes('win64'));
  if(portable){
    await cp(join(tools,portable.name,'bin'),join(stage,'media'),{recursive:true});
    await cp(join(tools,portable.name,'LICENSE.txt'),join(stage,'media','LICENSE-FFmpeg.txt'));
    const localProvenance=join(tools,portable.name,'provenance.json');
    const provenance=await stat(localProvenance).then(()=>localProvenance,()=>join(tools,'ffmpeg-provenance.json'));
    await cp(provenance,join(stage,'media','provenance.json'));
  }
}
const hasMedia=await stat(join(stage,'media')).then(value=>value.isDirectory(),()=>false);
if(!hasMedia&&(!development||process.platform==='win32'))throw new Error('未找到 FFmpeg 媒体组件。Windows 请先运行 pnpm prepare:media；其他平台打包需通过 VIDEO_QUICKLY_MEDIA_DIR 提供对应平台的组件及许可来源。');
if(hasMedia){
  const extension=process.platform==='win32'?'.exe':'';
  for(const executable of ['ffmpeg','ffprobe'])await stat(join(stage,'media',`${executable}${extension}`));
  const mediaProvenance=JSON.parse(await readFile(join(stage,'media','provenance.json'),'utf8'));
  await writeFile(join(stage,'media','SOURCE.txt'),[
    'FFmpeg is a separately licensed executable component.',
    'The bundled build license is included in LICENSE-FFmpeg.txt.',
    `FFmpeg corresponding source: ${mediaProvenance.correspondingSource}`,
    `Build scripts and dependency source recipes: ${mediaProvenance.source}`,
    'Exact build, download location and archive checksum are recorded in provenance.json.',
  ].join('\n'));
}else console.log('开发模式使用系统 FFmpeg；媒体处理需在 PATH 中安装 ffmpeg/ffprobe，或设置 VIDEO_QUICKLY_FFMPEG 和 VIDEO_QUICKLY_FFPROBE。');
// Homebrew keeps the Node license one directory above bin/.
const nodeLicenses=[join(dirname(process.execPath),'LICENSE'),resolve(dirname(process.execPath),'../LICENSE')];
let nodeLicense;
for(const candidate of nodeLicenses)if(await stat(candidate).then(value=>value.isFile(),()=>false)){nodeLicense=candidate;break;}
if(nodeLicense)await cp(nodeLicense,join(stage,'LICENSE-Node.txt'));
else{
  const response=await fetch(`https://nodejs.org/dist/${process.version}/LICENSE`);
  if(!response.ok)throw new Error('无法取得随附 Node.js 的许可文件');
  await writeFile(join(stage,'LICENSE-Node.txt'),await response.text());
}
const notices=join(stage,'third-party-licenses');await mkdir(notices,{recursive:true});
const packageStore=join(root,'node_modules','.pnpm');
const manifest=[];
for(const folder of await readdir(packageStore,{withFileTypes:true})){
 if(!folder.isDirectory())continue;
 const modules=join(packageStore,folder.name,'node_modules');
 const top=await readdir(modules,{withFileTypes:true}).catch(()=>[]);
 for(const entry of top){
  if(entry.isSymbolicLink()||!entry.isDirectory())continue;
  const candidates=entry.name.startsWith('@')?(await readdir(join(modules,entry.name),{withFileTypes:true})).filter(child=>child.isDirectory()&&!child.isSymbolicLink()).map(child=>join(modules,entry.name,child.name)):[join(modules,entry.name)];
  for(const candidate of candidates){
   const json=await readFile(join(candidate,'package.json'),'utf8').then(JSON.parse,()=>undefined);if(!json)continue;
   const files=(await readdir(candidate)).filter(name=>/^(licen[sc]e|copying|notice)(\.|$)/i.test(name)||(['gsap','@gsap/react'].includes(json.name)&&name==='README.md'));
   const label=`${json.name.replaceAll('/','+')}-${json.version}`;
   for(const file of files)if((await stat(join(candidate,file))).isFile())await cp(join(candidate,file),join(notices,`${label}-${file}`));
   manifest.push({name:json.name,version:json.version,license:json.license??'See package license',repository:json.repository,files});
  }
 }
}
await writeFile(join(notices,'manifest.json'),JSON.stringify(manifest,null,2));
await cp(join(root,'apps/desktop/src/assets/platforms/LICENSE'),join(notices,'platform-icons-LICENSE.txt'));
await writeFile(join(stage,'runtime-info.json'),JSON.stringify({nodeVersion:process.version,platform:process.platform,architecture:process.arch},null,2));
if(resolve(sidecar)!==join(root,'.generated','sidecar'))throw new Error('非法执行组件目录');
await rm(sidecar,{recursive:true,force:true});
await rename(stage,sidecar);
console.log(`执行组件已准备：${sidecar}`);
