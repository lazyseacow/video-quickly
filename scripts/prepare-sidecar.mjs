import { cp, mkdir, readdir, rename, rm, stat, writeFile, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const generated=join(root,'.generated');
const sidecar=join(generated,'sidecar');
const stage=join(generated,`sidecar-stage-${Date.now()}`);
await mkdir(generated,{recursive:true});
const runtime=join(root,'packages/runtime/dist/main.mjs');
await stat(runtime);
await mkdir(stage,{recursive:true});
const fromRuntime=createRequire(join(root,'packages/runtime/package.json'));
const fromVideo=createRequire(join(root,'packages/video/package.json'));
async function copyModule(name,from){
  const source=dirname(await realpath(from.resolve(`${name}/package.json`)));
  await cp(source,join(stage,'node_modules',name),{recursive:true,dereference:true,filter:path=>!path.includes(`${source}\\node_modules`)&&!path.includes(`${source}/node_modules`)});
  return createRequire(join(source,'package.json'));
}
const fromSqlite=await copyModule('better-sqlite3',fromRuntime);
const fromBindings=await copyModule('bindings',fromSqlite);
await copyModule('file-uri-to-path',fromBindings);
const fromCanvas=await copyModule('@napi-rs/canvas',fromVideo);
const canvasBinary=process.platform==='win32'?`@napi-rs/canvas-win32-${process.arch}-msvc`:process.platform==='darwin'?`@napi-rs/canvas-darwin-${process.arch}`:`@napi-rs/canvas-linux-${process.arch}-gnu`;
await copyModule(canvasBinary,fromCanvas);
await writeFile(join(stage,'package.json'),JSON.stringify({name:'video-quickly-runtime',version:'0.1.0',private:true,type:'module'}));
await cp(runtime,join(stage,'runtime.mjs'));
await cp(process.execPath,join(stage,process.platform==='win32'?'node.exe':'node'));
const mediaRoot=process.env.VIDEO_QUICKLY_MEDIA_DIR;
if(mediaRoot){await cp(resolve(mediaRoot),join(stage,'media'),{recursive:true});}
else{
  const tools=join(root,'.tools');
  const entries=await readdir(tools,{withFileTypes:true}).catch(()=>[]);
  const portable=entries.find(entry=>entry.isDirectory()&&entry.name.includes('ffmpeg')&&entry.name.includes('win64'));
  if(portable){
    await cp(join(tools,portable.name,'bin'),join(stage,'media'),{recursive:true});
    await cp(join(tools,portable.name,'LICENSE.txt'),join(stage,'media','LICENSE-FFmpeg.txt'));
    const provenance=join(tools,'ffmpeg-provenance.json');
    await cp(provenance,join(stage,'media','provenance.json'));
    await writeFile(join(stage,'media','SOURCE.txt'),[
      'FFmpeg is a separately licensed executable component.',
      'The bundled build license is included in LICENSE-FFmpeg.txt.',
      'Exact build, download location and archive checksum are recorded in provenance.json.',
      'FFmpeg corresponding source: https://github.com/FFmpeg/FFmpeg/tree/611cec792a',
      'Build scripts and dependency source recipes: https://github.com/BtbN/FFmpeg-Builds',
      'Build legal/configuration details: run ffmpeg -version and see the upstream build documentation.',
    ].join('\n'));
  }
}
const nodeLicense=join(dirname(process.execPath),'LICENSE');
if(await stat(nodeLicense).then(()=>true,()=>false))await cp(nodeLicense,join(stage,'LICENSE-Node.txt'));
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
   const files=(await readdir(candidate)).filter(name=>/^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
   const label=`${json.name.replaceAll('/','+')}-${json.version}`;
   for(const file of files)if((await stat(join(candidate,file))).isFile())await cp(join(candidate,file),join(notices,`${label}-${file}`));
   manifest.push({name:json.name,version:json.version,license:json.license??'See package license',repository:json.repository,files});
  }
 }
}
await writeFile(join(notices,'manifest.json'),JSON.stringify(manifest,null,2));
await writeFile(join(stage,'runtime-info.json'),JSON.stringify({nodeVersion:process.version,platform:process.platform,architecture:process.arch},null,2));
if(resolve(sidecar)!==join(root,'.generated','sidecar'))throw new Error('非法执行组件目录');
await rm(sidecar,{recursive:true,force:true});
await rename(stage,sidecar);
console.log(`执行组件已准备：${sidecar}`);
