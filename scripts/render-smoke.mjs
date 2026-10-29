import { build } from 'esbuild';
import { mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'.generated','render-smoke');
await mkdir(output,{recursive:true});
const resolveVideo=createRequire(join(root,'packages/video/package.json'));
await build({entryPoints:[join(root,'packages/video/src/node.ts')],outfile:join(output,'renderer.mjs'),platform:'node',target:'node24',format:'esm',bundle:true,plugins:[{name:'workspace-contracts',setup(builder){builder.onResolve({filter:/^@video-quickly\//},args=>({path:join(root,`packages/${args.path.replace('@video-quickly/','')}/src/index.ts`)}));builder.onResolve({filter:/^@napi-rs\/canvas$/},()=>({path:pathToFileURL(resolveVideo.resolve('@napi-rs/canvas')).href,external:true}));}}]});
const tools=await readdir(join(root,'.tools'),{withFileTypes:true}).catch(()=>[]);
const mediaLock=JSON.parse(await readFile(join(root,'scripts','media-manifest.json'),'utf8'));
const folder=(tools.find(entry=>entry.isDirectory()&&entry.name===mediaLock.directory)??tools.find(entry=>entry.isDirectory()&&entry.name.includes('ffmpeg')&&entry.name.includes('win64')))?.name;
const ffmpeg=process.env.VIDEO_QUICKLY_FFMPEG??(folder?join(root,'.tools',folder,'bin','ffmpeg.exe'):'ffmpeg');
const ffprobe=process.env.VIDEO_QUICKLY_FFPROBE??(folder?join(root,'.tools',folder,'bin','ffprobe.exe'):'ffprobe');
const {renderProject,probeMedia,runMedia}=await import(pathToFileURL(join(output,'renderer.mjs')).href);
const baseShot={id:'sample-1',title:'一纸功名，从何而来',narration:'这是一段本地生成的手绘示例。视频规格、画面和字幕共用一份时间轴。',visualPrompt:'手绘书院',durationUs:1_300_000,claimIds:[],locked:false,animation:{panX:.035,panY:0,zoom:1.04,transition:'fade'}};
const results=[];
for(const profile of [{width:640,height:360,frameRate:{numerator:30,denominator:1},fitMode:'contain',previewScale:.5},{width:360,height:640,frameRate:{numerator:30000,denominator:1001},fitMode:'cover',previewScale:.5}]){
 const project={id:'render-smoke',title:'本地手绘示例',templateId:'history-handdrawn',profile,shots:[baseShot,{...baseShot,id:'sample-2',title:'走进书院',durationUs:1_100_000}],revision:1,brief:'',claims:[],style:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),archived:false,workflow:{id:'smoke',version:1,name:'smoke',nodes:[],edges:[]}};
 const result=await renderProject({project,outputDirectory:join(output,`${profile.width}x${profile.height}`),ffmpegPath:ffmpeg,ffprobePath:ffprobe});
 const probe=await probeMedia(result.videoPath,ffprobe);
 if(probe.width!==profile.width||probe.height!==profile.height)throw new Error('Smoke output size mismatch');
 results.push({...result,probe});
}
const audio=join(output,'voice-fixture.wav');
await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1.215',audio]);
const sourceVideo=results[0].videoPath;
const records=[];
for(const [id,path,kind,mimeType] of [['fixture-audio',audio,'audio','audio/wav'],['fixture-video',sourceVideo,'video','video/mp4']]){
 const bytes=await readFile(path);records.push({id,name:id,path,kind,mimeType,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),version:1,createdAt:new Date().toISOString(),provenance:'local smoke fixture',retained:false,active:true});
}
const mediaProject={id:'media-smoke',title:'本地媒体测试',templateId:'generic',profile:{width:480,height:480,frameRate:{numerator:25,denominator:1},fitMode:'blur',previewScale:.5},shots:[{...baseShot,durationUs:500_000,audioAssetId:'fixture-audio',videoAssetId:'fixture-video'}],revision:1,brief:'',claims:[],style:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),archived:false,workflow:{id:'smoke',version:1,name:'smoke',nodes:[],edges:[]}};
const mediaResult=await renderProject({project:mediaProject,assets:records,outputDirectory:join(output,'media-fixtures'),ffmpegPath:ffmpeg,ffprobePath:ffprobe});
const mediaProbe=await probeMedia(mediaResult.videoPath,ffprobe);
if(mediaProbe.duration<1.215||!mediaProbe.audio||mediaProbe.frameRate!=='25/1')throw new Error('媒体测试未保留完整音频或输出帧率');
results.push({...mediaResult,probe:mediaProbe});
if(process.argv.includes('--4k')){
 const project={...mediaProject,id:'4k-smoke',profile:{width:3840,height:2160,frameRate:{numerator:24,denominator:1},fitMode:'contain',previewScale:.25},shots:[{...baseShot,durationUs:500_000}]};
 const result=await renderProject({project,outputDirectory:join(output,'3840x2160'),ffmpegPath:ffmpeg,ffprobePath:ffprobe});
 const probe=await probeMedia(result.videoPath,ffprobe);if(probe.width!==3840||probe.height!==2160||probe.frameRate!=='24/1')throw new Error('4K 视频规格校验失败');results.push({...result,probe});
}
await writeFile(join(output,'results.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
