import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { effectiveCaptionStyle, firstFrameAtUs, videoProfileSchema, type AssetRecord, type PreparedAudioMix, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { buildTimeline, captionGeometry, captionPages, createSubtitleCues, createTimedSrt, drawSceneFrame, frameTimeUs, type SceneFrame } from './index.js';
import { clipEditSource, resolveShotSpans } from './clip-edits.js';
import { audioMixProjectionKey, prepareAudioMix, resolveAudioProject } from './audio-mix.js';
import { createRenderSchedule, type RenderClipSchedule } from './render-schedule.js';
import { citationOverlayForShot, createCitationManifest, drawCitationOverlay, type CitationOverlay } from './citations.js';
import { resolveCaptionLayout, selectCaptionFont } from './caption-layout.js';
import { createCaptionAss } from './caption-ass.js';
import { hashMediaFile, probeMedia, runMedia } from './media-process.js';
import { keyframeVideoFrames } from './keyframe-video.js';
export { probeMedia, runMedia } from './media-process.js';

export interface RenderOptions {
  project: ProjectDocument;
  outputDirectory: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  assets?: AssetRecord[];
  signal?: AbortSignal;
  onProgress?: (value: number) => void;
  preparedAudioMix?: PreparedAudioMix;
}
export interface RenderResult { videoPath: string; coverPath: string; subtitlePath: string; timelinePath: string; warnings: string[] }

function subtitleStyle(width:number,height: number, referenceFooter=false): string {
  const geometry=captionGeometry(width,height,referenceFooter);
  // libass otherwise assumes a 384×288 script, scaling pixel-based footer margins differently per format.
  const coordinates=referenceFooter?`PlayResX=${width},PlayResY=${height},WrapStyle=2,`:'';
  return `${coordinates}FontName=Microsoft YaHei,FontSize=${Math.round(geometry.fontSize)},PrimaryColour=&H00F1F6FB,OutlineColour=&H00304028,BorderStyle=3,Outline=2,Shadow=0,MarginV=${Math.round(referenceFooter?height-geometry.bottom+2:height*.075)},Alignment=2`;
}

async function encodeCanvasShot(scene: SceneFrame & {durationUs:number}, path: string, ffmpeg: string, schedule: RenderClipSchedule, options: RenderOptions, readImage?: () => Promise<CanvasImageSource>): Promise<void> {
  const {width,height,frameRate}=scene.profile;
  const canvas=createCanvas(width,height);
  const context=canvas.getContext('2d');
  // napi-rs/canvas implements the Canvas 2D drawing API used by our browser painter.
  const browserSurface=canvas as unknown as HTMLCanvasElement;
  const rate=`${frameRate.numerator}/${frameRate.denominator}`;
  const args=['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-framerate',rate,'-i','pipe:0'];
  args.push('-frames:v',String(schedule.frameCount),'-map','0:v:0','-an','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-video_track_timescale',String(frameRate.numerator),'-movflags','+faststart',path);
  const child=spawn(ffmpeg,args,{windowsHide:true,stdio:['pipe','ignore','pipe'],signal:options.signal});
  let errors='';child.stderr.on('data',data=>{errors=(errors+String(data)).slice(-16000);});
  const completed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`镜头编码失败：${errors.slice(-2000)}`)));});
  // Attach rejection immediately, including an encoder failing before all frames arrive.
  completed.catch(()=>undefined);
  let inputError: Error | undefined;
  child.stdin.on('error', error => { inputError = error; });
  const count=schedule.frameCount;
  try{
    for(let frame=0;frame<count;frame++){
      if(options.signal?.aborted)throw new DOMException('导出已取消','AbortError');
      if(inputError)throw inputError;
      const current = readImage ? { ...scene, image: await readImage() } : scene;
      drawSceneFrame(browserSurface,current,frameTimeUs(schedule.firstFrame+frame,frameRate)-schedule.startUs);
      const pixels=context.getImageData(0,0,width,height).data;
      if(!child.stdin.write(pixels))await once(child.stdin,'drain');
      options.onProgress?.((frame+1)/count);
    }
    child.stdin.end();await completed;if(inputError)throw inputError;
  }catch(error){child.stdin.destroy();child.kill();await completed.catch(()=>undefined);throw error;}
}

async function encodeVideoShot(shot: Shot, project: ProjectDocument, asset: AssetRecord, citation: CitationOverlay | undefined, schedule: RenderClipSchedule, path: string, ffmpeg: string, ffprobe: string, options: RenderOptions): Promise<void> {
  const { width, height, frameRate } = project.profile, rate = `${frameRate.numerator}/${frameRate.denominator}`;
  const metadata = await probeMedia(asset.path, ffprobe, options.signal), [numerator, denominator] = (metadata.frameRate ?? rate).split('/').map(Number);
  const sourceFps = numerator > 0 && denominator > 0 ? numerator / denominator : frameRate.numerator / frameRate.denominator;
  const lastSourceSeconds = Math.max(0, (metadata.videoDuration ?? metadata.duration) - 1 / sourceFps);
  const referenceImage = citation ? `${path}.references.png` : undefined, parts: string[] = [];
  if (referenceImage) { const canvas = createCanvas(width, height); drawCitationOverlay(canvas as unknown as HTMLCanvasElement, citation!); await writeFile(referenceImage, canvas.toBuffer('image/png')); }
  const list = `${path}.list`;
  try {
    for (const [index, span] of resolveShotSpans(shot, project).entries()) {
      const first = firstFrameAtUs(schedule.startUs + span.outputStartUs, frameRate), end = firstFrameAtUs(schedule.startUs + span.outputEndUs, frameRate), count = end - first;
      if (!count) continue;
      const phaseUs = frameTimeUs(first, frameRate) - schedule.startUs - span.outputStartUs;
      const target = Math.min((span.videoInUs + phaseUs) / 1_000_000, lastSourceSeconds), seek = Math.max(0, target - 1);
      const part = `${path}.part-${index}.mp4`;
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x1d2724:s=${width}x${height}:r=${rate}`, '-ss', String(seek), '-i', asset.path];
      if (referenceImage) args.push('-i', referenceImage);
      const fit = project.profile.fitMode === 'cover' ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}` : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x1d2724`;
      const filters = [`[0:v]setsar=1,settb=1/${frameRate.numerator},setpts=N*${frameRate.denominator}[clock]`];
      if (project.profile.fitMode === 'blur') filters.push(`[1:v]setpts=PTS+(${seek}-${target})/TB,split=2[bg][fg]`, `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=20[background]`, `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[foreground]`, '[background][foreground]overlay=(W-w)/2:(H-h)/2,setsar=1[fit]');
      else filters.push(`[1:v]setpts=PTS+(${seek}-${target})/TB,${fit},setsar=1[fit]`);
      // The main CFR clock chooses the preceding source frame at each global sample instant.
      // No internal EDL span owns a separately rounded duration or a fresh source sampling phase.
      filters.push('[clock][fit]overlay=0:0:eof_action=repeat:shortest=0:repeatlast=1[video]');
      if (referenceImage) filters.push('[video][2:v]overlay=0:0:eof_action=repeat[referenced]');
      args.push('-filter_complex', filters.join(';'), '-map', referenceImage ? '[referenced]' : '[video]', '-frames:v', String(count), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-video_track_timescale', String(frameRate.numerator), part);
      parts.push(part); await runMedia(ffmpeg, args, { signal: options.signal });
    }
    if (!parts.length) throw new Error('镜头未分配到输出帧。');
    if (parts.length === 1) await rename(parts[0], path);
    else {
      await writeFile(list, parts.map(part => `file '${basename(part)}'`).join('\n'));
      await runMedia(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-an', '-c:v', 'copy', '-video_track_timescale', String(frameRate.numerator), path], { signal: options.signal });
    }
  } finally { await Promise.all([...parts, list, ...(referenceImage ? [referenceImage] : [])].map(file => rm(file, { force: true }))); }
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
  const resolvedProject = await resolveAudioProject({ project: options.project, assets: options.assets ?? [], outputDirectory: options.outputDirectory, ffmpegPath: ffmpeg, ffprobePath: ffprobe, signal: options.signal });
  const shots: Shot[] = resolvedProject.shots.map(shot => ({ ...shot, captionStyle: effectiveCaptionStyle(resolvedProject, shot) }));
  const project = { ...resolvedProject, shots };
  let mix = options.preparedAudioMix;
  if (mix && (mix.key !== audioMixProjectionKey(options.project, options.assets ?? []) || await hashMediaFile(mix.path, options.signal) !== mix.sha256)) throw new Error('声音混音与当前导出项目不一致，请重新准备声音。');
  mix ??= await prepareAudioMix({ project: options.project, assets: options.assets ?? [], outputDirectory: join(options.outputDirectory, 'audio'), ffmpegPath: ffmpeg, ffprobePath: ffprobe, signal: options.signal });
  const warnings: string[] = [...mix.warnings];
  const schedule = createRenderSchedule(shots, profile.frameRate);
  const citations=createCitationManifest({...options.project,shots});
  const referenceFooter=citations.display==='numbers'&&citations.shots.some(shot=>shot.numbers.length>0);
  const captionLayoutFor=(shot:Shot)=>resolveCaptionLayout(profile.width,profile.height,shot.captionStyle,{referenceFooter,template:Boolean(shot.sceneTemplate)});
  const captionFontFor=(shot:Shot)=>selectCaptionFont(shot.captionStyle?.fontId??'sans',name=>GlobalFonts.has(name));
  const sourceIds=new Set(citations.references.flatMap(reference=>reference.evidence.map(evidence=>evidence.sourceId)));
  for(const source of options.project.researchSources??[])if(sourceIds.has(source.id)&&createHash('sha256').update(source.content,'utf8').digest('hex')!==source.sha256)throw new Error(`资料「${source.title}」正文校验失败，请重新导入资料。`);
  warnings.push(...citations.warnings);
  const segments:string[]=[];
  for(let index=0;index<shots.length;index++){
    const shot=shots[index];
    const citation=citationOverlayForShot(citations,shot.id);
    const imageAsset=!shot.sceneTemplate&&shot.assetId?assets.get(shot.assetId):undefined;
    const videoAsset=!shot.sceneTemplate&&shot.videoAssetId?assets.get(shot.videoAssetId):undefined;
    const timing = schedule[index];
    for (const asset of [imageAsset, videoAsset]) if (asset) {
      if (!asset.active || (asset.projectId !== undefined && asset.projectId !== project.id)) throw new Error('画面必须引用当前项目或共享素材库中的有效素材。');
      if (await hashMediaFile(asset.path, options.signal) !== asset.sha256) throw new Error(`素材“${asset.name}”校验失败，请重新导入文件`);
    }
    const { audioAssetId: _audio, audioInUs: _audioIn, audioProcessing: _processing, captionTrack: _captions, narration: _narration, clipEdit: _edit, sourceInUs: _sourceIn, videoInUs: _videoIn, sceneInUs: _sceneIn, ...visualShot } = shot;
    const visualSpans = resolveShotSpans(shot, project).map(span => [span.outputStartUs, span.durationUs, span.videoInUs, span.sceneInUs]);
    const original = clipEditSource(shot, project)?.original, frozenVideo = clipEditSource(shot, project)?.assetHashes.find(value => value.assetId === videoAsset?.id);
    if (frozenVideo && frozenVideo.sha256 !== videoAsset?.sha256) throw new Error('剪辑来源视频已变化，请恢复原素材或重新建立剪辑。');
    const sceneIdentity = { durationUs: shot.sceneDurationUs ?? original?.sceneDurationUs ?? original?.durationUs ?? shot.durationUs, index: shot.sceneIndex ?? original?.sceneIndex ?? index };
    const fingerprint=createHash('sha256').update(JSON.stringify({shot:visualShot,profile,image:imageAsset?.sha256,video:videoAsset?.sha256,citation,referenceFooter:referenceFooter||undefined,captionLayout:shot.captionStyle?captionLayoutFor(shot):undefined,visualSpans,sceneIdentity,timing:{count:timing.frameCount,phase:timing.phaseUs},renderer:shot.animation.keyframes?.length?'canvas-v6-keyframes':'canvas-v5-global-edl'})).digest('hex').slice(0,24);
    const segment=join(options.outputDirectory,`segment-${fingerprint}.mp4`);
    const manifestPath=segment+'.json';
    const exists=await stat(segment).then(()=>true,()=>false);
    if(exists){
      try{
        const manifest:unknown=JSON.parse(await readFile(manifestPath,'utf8'));
        const saved=manifest as {sha256?:string};
        const digest=await hashMediaFile(segment, options.signal);
        const metadata=await probeMedia(segment,ffprobe,options.signal);
        const rate=profile.frameRate.numerator/profile.frameRate.denominator;
        const [num,den]=(metadata.frameRate??'0/1').split('/').map(Number);
        if(saved.sha256===digest&&metadata.width===profile.width&&metadata.height===profile.height&&Math.abs(num/den-rate)<.0001&&Math.abs((metadata.videoDuration ?? metadata.duration)-timing.frameCount/rate)<1/rate){segments.push(segment);options.onProgress?.((index+1)/shots.length);continue;}
      }catch(error){if(options.signal?.aborted)throw error;}
    }
    const temporary=join(options.outputDirectory,`segment-${fingerprint}.partial.mp4`);
    const progress=(value:number)=>options.onProgress?.((index+value)/shots.length);
    if(videoAsset && shot.animation.keyframes?.length){
      const frames = keyframeVideoFrames(shot, project, videoAsset, timing, ffmpeg, ffprobe, options.signal);
      const scene: SceneFrame & { durationUs: number } = { ...shot, narration: '', captionTrack: { timeBase: 'scene', alignment: 'manual', cues: [] }, shotIndex: index, citation, referenceFooter, profile: { ...profile, fitMode: 'contain' }, clipEditContext: project };
      try {
        await encodeCanvasShot(scene, temporary, ffmpeg, timing, { ...options, onProgress: progress }, async () => { const frame = await frames.next(); if (frame.done) throw new Error('关键帧视频缺少画面帧。'); return frame.value; });
        if (!(await frames.next()).done) throw new Error('关键帧视频解码返回额外画面帧。');
      } finally { await frames.return(undefined); }
    }else if(videoAsset){
      await encodeVideoShot(shot, project, videoAsset, citation, timing, temporary, ffmpeg, ffprobe, options);
      progress(1);
    }else{
      const image=imageAsset?await loadImage(imageAsset.path):undefined;
      const scene:SceneFrame&{durationUs:number}={...shot,narration:'',captionTrack:{timeBase:'scene',alignment:'manual',cues:[]},shotIndex:index,citation,referenceFooter,profile,clipEditContext:project,image:image as unknown as CanvasImageSource|undefined,label:options.project.templateId==='history-handdrawn'?'历史手绘 · 示意复原':undefined};
      await encodeCanvasShot(scene,temporary,ffmpeg,timing,{...options,onProgress:progress});
    }
    const metadata=await probeMedia(temporary,ffprobe,options.signal);
    if(metadata.width!==profile.width||metadata.height!==profile.height)throw new Error('镜头输出尺寸与项目规格不一致');
    await rename(temporary,segment);await writeFile(manifestPath,JSON.stringify({sha256:await hashMediaFile(segment,options.signal),profile,durationUs:shot.durationUs}),'utf8');segments.push(segment);
  }
  const listPath=join(options.outputDirectory,'segments.txt');
  await writeFile(listPath,segments.map(path=>`file '${basename(path)}'`).join('\n'),'utf8');
  const videoPath=join(options.outputDirectory,'video.mp4'),temporaryVideo=join(options.outputDirectory,'video.partial.mp4');
  const subtitleCanvas=createCanvas(profile.width,profile.height);const captionContext=subtitleCanvas.getContext('2d');
  const subtitlePath=join(options.outputDirectory,'subtitles.srt');
  const pages=(text:string,shot:Pick<Shot,'captionStyle'|'sceneTemplate'>)=>{
    const layout=resolveCaptionLayout(profile.width,profile.height,shot.captionStyle,{referenceFooter,template:Boolean(shot.sceneTemplate)});
    captionContext.font=layout.font;
    return captionPages(text,value=>captionContext.measureText(value).width,layout.textWidth,layout.maxLines);
  };
  const subtitles=createTimedSrt(shots,pages,project);
  await writeFile(subtitlePath,subtitles,'utf8');
  const styledCaptions=shots.some(shot=>Boolean(shot.captionStyle));
  if(styledCaptions){
    const timeline=buildTimeline(shots);let index=0;
    const cues=createSubtitleCues(shots,pages,project).map(cue=>{
      while(index<shots.length-1&&cue.startUs>=timeline[index].endUs)index++;
      const shot=shots[index];return {...cue,layout:captionLayoutFor(shot),fontName:captionFontFor(shot)};
    });
    await writeFile(join(options.outputDirectory,'subtitles.ass'),createCaptionAss(cues,profile.width,profile.height,profile.frameRate),'utf8');
  }
  const rate=`${profile.frameRate.numerator}/${profile.frameRate.denominator}`;
  const totalDuration=shots.reduce((total,shot)=>total+shot.durationUs,0)/1e6;
  const finalArgs=['-hide_banner','-loglevel','error','-y'];
  segments.forEach(segment=>finalArgs.push('-i',segment));
  finalArgs.push('-i',mix.path);
  const filters:string[]=[];
  shots.forEach((shot,index)=>{
    const next=shots[index+1];const extend=next&&next.animation.transition!=='cut'?.2:0;
    filters.push(`[${index}:v]setsar=1,settb=AVTB,setpts=N*1000000*${profile.frameRate.denominator}/${profile.frameRate.numerator},trim=end_frame=${schedule[index].frameCount}${extend?`,tpad=stop_mode=clone:stop_duration=${extend}`:''}[v${index}]`);
  });
  let current='v0';
  for(let index=1;index<shots.length;index++){
    const output=`joined${index}`, offset=schedule[index].firstFrame*profile.frameRate.denominator/profile.frameRate.numerator;
    if(shots[index].animation.transition==='cut')filters.push(`[${current}][v${index}]concat=n=2:v=1:a=0[${output}]`);
    else filters.push(`[${current}][v${index}]xfade=transition=${shots[index].animation.transition==='wipe'?'wipeleft':'fade'}:duration=0.2:offset=${offset}[${output}]`);
    current=output;
  }
  const totalFrames=schedule.at(-1)!.endFrame, presentationDuration=totalFrames*profile.frameRate.denominator/profile.frameRate.numerator;
  filters.push(`[${shots.length}:a]apad=whole_len=${Math.round(presentationDuration*48000)},atrim=end_sample=${Math.round(presentationDuration*48000)}[mixed]`);
  if(subtitles.trim()){
    const painter=styledCaptions?`subtitles=subtitles.ass:original_size=${profile.width}x${profile.height}`:`subtitles=subtitles.srt:original_size=${profile.width}x${profile.height}:force_style='${subtitleStyle(profile.width,profile.height,referenceFooter)}'`;
    filters.push(`[${current}]${painter}[captioned]`);current='captioned';
  }
  finalArgs.push('-filter_complex',filters.join(';'),'-map',`[${current}]`,'-map','[mixed]','-t',String(presentationDuration),'-frames:v',String(totalFrames),'-r',rate,'-fps_mode','cfr','-video_track_timescale',String(profile.frameRate.numerator),'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-movflags','+faststart',temporaryVideo);
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
  await writeFile(timelinePath,JSON.stringify({profile,clips:buildTimeline(shots),musicClips:project.musicClips??[],audioMix:{...mix,path:undefined},renderSchedule:schedule,citations,captionLayouts:shots.map(shot=>({shotId:shot.id,fontName:captionFontFor(shot),layout:captionLayoutFor(shot)})),warnings,videoSha256:await hashMediaFile(videoPath,options.signal)},null,2),'utf8');
  return {videoPath,coverPath,subtitlePath,timelinePath,warnings};
}
