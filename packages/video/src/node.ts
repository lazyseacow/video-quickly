import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { videoProfileSchema, type AssetRecord, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { buildTimeline, captionPages, createTimedSrt, drawSceneFrame, frameCount, frameTimeUs, type SceneFrame } from './index.js';

export interface RenderOptions {
  project: ProjectDocument;
  outputDirectory: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  assets?: AssetRecord[];
  signal?: AbortSignal;
  onProgress?: (value: number) => void;
}
export interface RenderResult { videoPath: string; coverPath: string; subtitlePath: string; timelinePath: string; warnings: string[] }

function quantizeDuration(durationUs:number,rate:ProjectDocument['profile']['frameRate']):number{
  return Math.ceil(Math.ceil(durationUs*rate.numerator/(1e6*rate.denominator))*1e6*rate.denominator/rate.numerator);
}

export async function runMedia(executable: string, args: string[], options: { cwd?: string; signal?: AbortSignal } = {}): Promise<string> {
  const child=spawn(executable,args,{cwd:options.cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:options.signal});
  let output='',errors='';
  child.stdout.on('data',data=>{output+=String(data);});
  child.stderr.on('data',data=>{errors=(errors+String(data)).slice(-16000);});
  const [code]=await once(child,'close');
  if(code!==0)throw new Error(`媒体处理失败：${errors.slice(-2400) || `退出码 ${String(code)}`}`);
  return output;
}

export async function probeMedia(path: string, ffprobePath='ffprobe', signal?: AbortSignal): Promise<{ width?: number; height?: number; duration: number; videoDuration?:number; audioDuration?:number; frameRate?: string; audio: boolean }> {
  const raw=await runMedia(ffprobePath,['-v','error','-show_streams','-show_format','-of','json',path],{signal});
  const value:unknown=JSON.parse(raw);
  if(typeof value!=='object'||value===null)throw new Error('媒体探测返回无效内容');
  const parsed=value as {streams?:Array<{codec_type?:string;width?:number;height?:number;avg_frame_rate?:string;duration?:string}>;format?:{duration?:string}};
  const video=parsed.streams?.find(stream=>stream.codec_type==='video');
  const audio=parsed.streams?.find(stream=>stream.codec_type==='audio');
  const duration=Number(parsed.format?.duration??video?.duration??0);
  if(!Number.isFinite(duration)||duration<=0)throw new Error('媒体时长无效');
  const streamDuration=(stream:typeof video)=>{const value=Number(stream?.duration);return Number.isFinite(value)&&value>0?value:undefined;};
  return {width:video?.width,height:video?.height,duration,videoDuration:streamDuration(video),audioDuration:streamDuration(audio),frameRate:video?.avg_frame_rate,audio:!!audio};
}

function subtitleStyle(width:number,height: number): string {
  return `FontName=Microsoft YaHei,FontSize=${Math.round(Math.max(12,Math.min(width*.027,height*.047)))},PrimaryColour=&H00F1F6FB,OutlineColour=&H00304028,BorderStyle=3,Outline=2,Shadow=0,MarginV=${Math.round(height*.075)},Alignment=2`;
}

async function encodeCanvasShot(scene: SceneFrame & {durationUs:number}, path: string, ffmpeg: string, audioPath: string|undefined, options: RenderOptions): Promise<void> {
  const {width,height,frameRate}=scene.profile;
  const canvas=createCanvas(width,height);
  const context=canvas.getContext('2d');
  // napi-rs/canvas implements the Canvas 2D drawing API used by our browser painter.
  const browserSurface=canvas as unknown as HTMLCanvasElement;
  const rate=`${frameRate.numerator}/${frameRate.denominator}`;
  const args=['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-framerate',rate,'-i','pipe:0'];
  args.push(...(audioPath?['-i',audioPath]:['-f','lavfi','-i','anullsrc=r=48000:cl=stereo']));
  args.push('-t',String(scene.durationUs/1e6),'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2','-af','loudnorm=I=-16:TP=-1.5:LRA=11,apad','-movflags','+faststart',path);
  const child=spawn(ffmpeg,args,{windowsHide:true,stdio:['pipe','ignore','pipe'],signal:options.signal});
  let errors='';child.stderr.on('data',data=>{errors=(errors+String(data)).slice(-16000);});
  const completed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`镜头编码失败：${errors.slice(-2000)}`)));});
  // Attach rejection immediately, including an encoder failing before all frames arrive.
  completed.catch(()=>undefined);
  const count=frameCount(scene.durationUs,frameRate);
  try{
    for(let frame=0;frame<count;frame++){
      if(options.signal?.aborted)throw new DOMException('导出已取消','AbortError');
      drawSceneFrame(browserSurface,scene,frameTimeUs(frame,frameRate));
      const pixels=context.getImageData(0,0,width,height).data;
      if(!child.stdin.write(pixels))await once(child.stdin,'drain');
      options.onProgress?.((frame+1)/count);
    }
    child.stdin.end();await completed;
  }catch(error){child.stdin.destroy();child.kill();await completed.catch(()=>undefined);throw error;}
}

/** Encode real project media locally. Every completed segment is content-addressed for reuse. */
export async function renderProject(options: RenderOptions): Promise<RenderResult> {
  const profile=videoProfileSchema.parse(options.project.profile);
  const ffmpeg=options.ffmpegPath??process.env.VIDEO_QUICKLY_FFMPEG??'ffmpeg';
  const ffprobe=options.ffprobePath??process.env.VIDEO_QUICKLY_FFPROBE??join(dirname(ffmpeg),process.platform==='win32'?'ffprobe.exe':'ffprobe');
  await mkdir(options.outputDirectory,{recursive:true});
  if(process.platform==='win32')GlobalFonts.loadFontsFromDir('C:/Windows/Fonts');
  if(!options.project.shots.length)throw new Error('请先添加分镜');
  const assets=new Map((options.assets??[]).map(asset=>[asset.id,asset]));
  const shots:Shot[]=options.project.shots.map(shot=>({...shot}));
  const warnings:string[]=[];
  for(const shot of shots){
    if(shot.audioAssetId){const audio=assets.get(shot.audioAssetId);if(!audio)throw new Error(`镜头“${shot.title}”的配音文件不存在`);const metadata=await probeMedia(audio.path,ffprobe,options.signal);if(!metadata.audio)throw new Error(`“${audio.name}”没有音轨`);shot.durationUs=Math.max(shot.durationUs,Math.ceil(metadata.duration*1e6));}
    else warnings.push(`“${shot.title}”尚未添加配音，本镜头使用静音音轨。`);
    shot.durationUs=quantizeDuration(shot.durationUs,profile.frameRate);
  }
  const segments:string[]=[];
  for(let index=0;index<shots.length;index++){
    const shot=shots[index];
    const imageAsset=shot.assetId?assets.get(shot.assetId):undefined;
    const videoAsset=shot.videoAssetId?assets.get(shot.videoAssetId):undefined;
    const audioAsset=shot.audioAssetId?assets.get(shot.audioAssetId):undefined;
    for(const asset of [imageAsset,videoAsset,audioAsset]){if(asset){const bytes=await readFile(asset.path);if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw new Error(`素材“${asset.name}”校验失败，请重新导入文件`);}}
    const fingerprint=createHash('sha256').update(JSON.stringify({shot,profile,image:imageAsset?.sha256,video:videoAsset?.sha256,audio:audioAsset?.sha256,renderer:'canvas-v3'})).digest('hex').slice(0,24);
    const segment=join(options.outputDirectory,`segment-${fingerprint}.mp4`);
    const manifestPath=segment+'.json';
    const exists=await stat(segment).then(()=>true,()=>false);
    if(exists){
      try{
        const manifest:unknown=JSON.parse(await readFile(manifestPath,'utf8'));
        const saved=manifest as {sha256?:string};
        const digest=createHash('sha256').update(await readFile(segment)).digest('hex');
        const metadata=await probeMedia(segment,ffprobe,options.signal);
        const rate=profile.frameRate.numerator/profile.frameRate.denominator;
        const [num,den]=(metadata.frameRate??'0/1').split('/').map(Number);
        if(saved.sha256===digest&&metadata.width===profile.width&&metadata.height===profile.height&&Math.abs(num/den-rate)<.0001&&metadata.duration+1/rate>=shot.durationUs/1e6){segments.push(segment);options.onProgress?.((index+1)/shots.length);continue;}
      }catch(error){if(options.signal?.aborted)throw error;}
    }
    const temporary=join(options.outputDirectory,`segment-${fingerprint}.partial.mp4`);
    const progress=(value:number)=>options.onProgress?.((index+value)/shots.length);
    if(videoAsset){
      const ratio=`${profile.frameRate.numerator}/${profile.frameRate.denominator}`;
      const fit=profile.fitMode==='cover'?`scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height}`:`scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:color=0x1d2724`;
      const vf=`${fit},fps=${ratio},tpad=stop_mode=clone:stop_duration=${shot.durationUs/1e6}`;
      const args=['-hide_banner','-loglevel','error','-y','-i',videoAsset.path];
      args.push(...(audioAsset?['-i',audioAsset.path]:['-f','lavfi','-i','anullsrc=r=48000:cl=stereo']));
      if(profile.fitMode==='blur')args.push('-filter_complex',`[0:v]split=2[bg][fg];[bg]scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height},gblur=sigma=20[background];[fg]scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease[foreground];[background][foreground]overlay=(W-w)/2:(H-h)/2,fps=${ratio},tpad=stop_mode=clone:stop_duration=${shot.durationUs/1e6}[fit]`,'-map','[fit]');
      else args.push('-map','0:v:0','-vf',vf);
      args.push('-t',String(shot.durationUs/1e6),'-map','1:a:0','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2','-af','loudnorm=I=-16:TP=-1.5:LRA=11,apad',temporary);
      await runMedia(ffmpeg,args,{cwd:options.outputDirectory,signal:options.signal});progress(1);
    }else{
      const image=imageAsset?await loadImage(imageAsset.path):undefined;
      const scene:SceneFrame&{durationUs:number}={title:shot.title,narration:'',shotIndex:index,profile,durationUs:shot.durationUs,animation:shot.animation,image:image as unknown as CanvasImageSource|undefined,label:options.project.templateId==='history-handdrawn'?'历史手绘 · 示意复原':undefined};
      await encodeCanvasShot(scene,temporary,ffmpeg,audioAsset?.path,{...options,onProgress:progress});
    }
    const metadata=await probeMedia(temporary,ffprobe,options.signal);
    if(metadata.width!==profile.width||metadata.height!==profile.height)throw new Error('镜头输出尺寸与项目规格不一致');
    await rename(temporary,segment);await writeFile(manifestPath,JSON.stringify({sha256:createHash('sha256').update(await readFile(segment)).digest('hex'),profile,durationUs:shot.durationUs}),'utf8');segments.push(segment);
  }
  const listPath=join(options.outputDirectory,'segments.txt');
  await writeFile(listPath,segments.map(path=>`file '${basename(path)}'`).join('\n'),'utf8');
  const videoPath=join(options.outputDirectory,'video.mp4'),temporaryVideo=join(options.outputDirectory,'video.partial.mp4');
  const subtitleCanvas=createCanvas(profile.width,profile.height);const captionContext=subtitleCanvas.getContext('2d');
  captionContext.font=`500 ${Math.max(12,Math.min(profile.width*.027,profile.height*.047))}px "Microsoft YaHei", sans-serif`;
  const subtitlePath=join(options.outputDirectory,'subtitles.srt');
  await writeFile(subtitlePath,createTimedSrt(shots,text=>captionPages(text,value=>captionContext.measureText(value).width,profile.width*.78,profile.height>profile.width?3:2)),'utf8');
  const rate=`${profile.frameRate.numerator}/${profile.frameRate.denominator}`;
  const totalDuration=shots.reduce((total,shot)=>total+shot.durationUs,0)/1e6;
  const finalArgs=['-hide_banner','-loglevel','error','-y'];
  segments.forEach(segment=>finalArgs.push('-i',segment));
  const filters:string[]=[];
  shots.forEach((shot,index)=>{
    const next=shots[index+1];const extend=next&&next.animation.transition!=='cut'?.2:0;
    filters.push(`[${index}:v]fps=${rate},settb=AVTB,setpts=PTS-STARTPTS,trim=duration=${shot.durationUs/1e6}${extend?`,tpad=stop_mode=clone:stop_duration=${extend}`:''}[v${index}]`);
    filters.push(`[${index}:a]atrim=duration=${shot.durationUs/1e6},asetpts=PTS-STARTPTS,apad=whole_dur=${shot.durationUs/1e6}[a${index}]`);
  });
  let current='v0',offset=shots[0].durationUs/1e6;
  for(let index=1;index<shots.length;index++){
    const output=`joined${index}`;
    if(shots[index].animation.transition==='cut')filters.push(`[${current}][v${index}]concat=n=2:v=1:a=0[${output}]`);
    else filters.push(`[${current}][v${index}]xfade=transition=${shots[index].animation.transition==='wipe'?'wipeleft':'fade'}:duration=0.2:offset=${offset}[${output}]`);
    current=output;offset+=shots[index].durationUs/1e6;
  }
  filters.push(`${shots.map((_,index)=>`[a${index}]`).join('')}concat=n=${shots.length}:v=0:a=1[aout]`);
  if(shots.some(shot=>shot.narration.trim())){filters.push(`[${current}]subtitles=subtitles.srt:original_size=${profile.width}x${profile.height}:force_style='${subtitleStyle(profile.width,profile.height)}'[captioned]`);current='captioned';}
  finalArgs.push('-filter_complex',filters.join(';'),'-map',`[${current}]`,'-map','[aout]','-t',String(totalDuration),'-r',rate,'-fps_mode','cfr','-video_track_timescale',String(profile.frameRate.numerator),'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-movflags','+faststart',temporaryVideo);
  await runMedia(ffmpeg,finalArgs,{cwd:options.outputDirectory,signal:options.signal});
  const final=await probeMedia(temporaryVideo,ffprobe,options.signal);
  if(final.width!==profile.width||final.height!==profile.height)throw new Error('成片输出尺寸不正确');
  const [rateNumerator,rateDenominator]=(final.frameRate??'0/1').split('/').map(Number);
  const expectedRate=profile.frameRate.numerator/profile.frameRate.denominator;
  if(Math.abs(rateNumerator/rateDenominator-expectedRate)>.0001)throw new Error('成片帧率与导出规格不一致');
  if(!final.videoDuration||final.videoDuration+1/expectedRate<totalDuration||!final.audioDuration||final.audioDuration+.03<totalDuration)throw new Error('成片画面或声音时长不足，请重新合成');
  await rename(temporaryVideo,videoPath);
  const coverPath=join(options.outputDirectory,'cover.png');
  await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-i',videoPath,'-frames:v','1',coverPath],{signal:options.signal});
  const timelinePath=join(options.outputDirectory,'timeline.json');
  await writeFile(timelinePath,JSON.stringify({profile,clips:buildTimeline(shots),warnings,videoSha256:createHash('sha256').update(await readFile(videoPath)).digest('hex')},null,2),'utf8');
  return {videoPath,coverPath,subtitlePath,timelinePath,warnings};
}
