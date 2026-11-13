import type { CaptionStyle, FrameRate, Shot, VideoProfile } from '@video-quickly/contracts';
import { captionAtTime, projectCaptionCues, type CaptionClip, type CaptionPages } from './captions.js';
import { mediaSourceInUs } from './audio.js';
import { clipEditSource, resolveShotTime, sourceCaptionTrack, type ClipEditContext } from './clip-edits.js';
import { drawSceneTemplate } from './scene-templates.js';
import { captionBox, resolveCaptionLayout, safeCaptionStyle } from './caption-layout.js';
import { sampleMotion } from './keyframes.js';
export { keyframePreviewWindow, sampleMotion, motionSceneTimeUs, motionLocalTimeUs } from './keyframes.js';
export { createRenderSchedule } from './render-schedule.js';
export { createTransitionTimeline, sampleTransition, wipeLeftIncomingStartX } from './transitions.js';
export { captionAtTime, createEstimatedCaptionTrack, projectCaptionCues, replaceVisibleCaptionCues, splitCaptionText } from './captions.js';
export { mediaSourceInUs } from './audio.js';
export { clipEditSource, sourceCaptionTrack, type ClipEditContext } from './clip-edits.js';
export { captionFontFamily, selectCaptionFont, safeCaptionStyle, captionGeometry, resolveCaptionLayout, captionBox } from './caption-layout.js';

export interface TimelineClip { shotId: string; index: number; startUs: number; durationUs: number; endUs: number }
export interface SceneFrame { title: string; narration: string; shotIndex: number; sceneIndex?: number; sceneTemplate?: Shot['sceneTemplate']; captionStyle?: CaptionStyle | null; profile: VideoProfile; durationUs?: number; sourceInUs?: number; audioInUs?: number; videoInUs?: number; sceneInUs?: number; sceneDurationUs?: number; captionTrack?: Shot['captionTrack']; clipEdit?: Shot['clipEdit']; clipEditContext?: ClipEditContext; animation?: Shot['animation']; image?: CanvasImageSource; label?: string; sample?: boolean }

export function buildTimeline(shots: ReadonlyArray<Pick<Shot, 'id' | 'durationUs'>>): TimelineClip[] {
  let cursor = 0;
  return shots.map((shot, index) => {
    const clip = { shotId: shot.id, index, startUs: cursor, durationUs: shot.durationUs, endUs: cursor + shot.durationUs };
    cursor = clip.endUs;
    return clip;
  });
}

export function frameCount(durationUs: number, rate: FrameRate): number {
  return Math.ceil(durationUs * rate.numerator / (1_000_000 * rate.denominator) - .0001);
}

export function frameTimeUs(frame: number, rate: FrameRate): number {
  return Math.round(frame * 1_000_000 * rate.denominator / rate.numerator);
}

function timestamp(timeUs: number): string {
  const ms = Math.round(timeUs / 1000);
  return `${Math.floor(ms / 3_600_000).toString().padStart(2, '0')}:${Math.floor(ms / 60_000 % 60).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')},${(ms % 1000).toString().padStart(3, '0')}`;
}

type NarrationClip = CaptionClip & Pick<Shot, 'id'> & Partial<Pick<Shot, 'sceneTemplate' | 'captionStyle'>>;
export interface SubtitleCue { startUs: number; endUs: number; lines: string[] }
export type SubtitlePages = (text: string, shot: NarrationClip) => string[][];

export function createSubtitleCues(shots: ReadonlyArray<NarrationClip>, pages: SubtitlePages, context: ClipEditContext = {}): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let startUs = 0;
  let previousCueId: string | undefined;
  shots.forEach((shot, index) => {
    const previous = shots[index - 1];
    const track = sourceCaptionTrack(shot, context);
    const offset = (value: CaptionClip) => track?.timeBase === 'source' ? mediaSourceInUs(value, 'audio', context) : track?.timeBase === 'clip' ? value.clipEdit?.inUs ?? 0 : value.clipEdit ? resolveShotTime(value, context, 0).sceneUs : value.sceneInUs ?? 0;
    const sameTrack = track ? JSON.stringify(previous && sourceCaptionTrack(previous, context)) === JSON.stringify(track) : !previous?.captionTrack && shot.sceneDurationUs !== undefined && previous?.sceneDurationUs === shot.sceneDurationUs && previous.narration === shot.narration;
    const sameStyle = JSON.stringify(safeCaptionStyle(previous?.captionStyle)) === JSON.stringify(safeCaptionStyle(shot.captionStyle));
    const previousEnd = previous?.clipEdit ? resolveShotTime(previous, context, previous.durationUs) : undefined;
    const previousEndUs = previousEnd && track?.timeBase !== 'clip' ? track?.timeBase === 'source' ? previousEnd.audioUs : previousEnd.sceneUs : previous ? offset(previous) + previous.durationUs : 0;
    const continuation = previous && sameTrack && sameStyle && Math.abs(previousEndUs - offset(shot)) <= 1;
    let firstVisible = true;
    projectCaptionCues(shot, startUs, text => pages(text, shot), context).forEach(projected => {
      const lines = projected.text.split('\n');
      const cue = { startUs: projected.startUs, endUs: projected.endUs, lines };
      const last = cues.at(-1);
      if (continuation && firstVisible && previousCueId === projected.id && last && Math.abs(last.endUs - cue.startUs) <= 1 && JSON.stringify(last.lines) === JSON.stringify(lines)) last.endUs = cue.endUs;
      else cues.push(cue);
      previousCueId = projected.id;
      firstVisible = false;
    });
    startUs += shot.durationUs;
  });
  return cues;
}

function subtitleText(cues: SubtitleCue[]): string {
  return cues.map((cue, index) => `${index + 1}\n${timestamp(cue.startUs)} --> ${timestamp(cue.endUs)}\n${cue.lines.join('\n')}\n`).join('\n');
}

export function createSrt(shots: ReadonlyArray<NarrationClip>, context: ClipEditContext = {}): string {
  return subtitleText(createSubtitleCues(shots, text => text.trim() ? [[text.trim()]] : [], context));
}

export function captionPages(text:string,measure:(text:string)=>number,width:number,maxLines:number):string[][]{
  const lines:string[]=[];let current='';
  for(const character of text.trim().replace(/\r\n?/g,'\n')){
    if(character==='\n'){if(current)lines.push(current);current='';continue;}
    if(current&&measure(current+character)>width){lines.push(current);current=character;}else current+=character;
  }
  if(current)lines.push(current);
  return Array.from({length:Math.ceil(lines.length/maxLines)},(_,index)=>lines.slice(index*maxLines,(index+1)*maxLines));
}

export function createTimedSrt(shots: ReadonlyArray<NarrationClip>, pages: SubtitlePages, context: ClipEditContext = {}): string {
  return subtitleText(createSubtitleCues(shots, pages, context));
}

function drawDefaultPicture(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const size = Math.min(width, height) * .24;
  ctx.fillStyle = '#262626';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate((width - size) / 2, (height - size) / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = '#a3a3a3';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(3, 3, 18, 18, 2);
  for (const x of [8, 16]) {
    ctx.moveTo(x, 3);
    ctx.lineTo(x, 21);
  }
  for (const y of [9, 15]) {
    ctx.moveTo(3, y);
    ctx.lineTo(8, y);
    ctx.moveTo(16, y);
    ctx.lineTo(21, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawCaptions(ctx: CanvasRenderingContext2D, scene: SceneFrame, width: number, height: number, timeUs: number) {
  if (!sourceCaptionTrack(scene, scene.clipEditContext) && !scene.narration.trim()) return;
  ctx.save(); ctx.textAlign='center'; ctx.textBaseline='alphabetic';
  const layout=resolveCaptionLayout(width,height,scene.captionStyle);
  ctx.font=layout.font;
  const pages:CaptionPages=text=>captionPages(text,value=>ctx.measureText(value).width,layout.textWidth,layout.maxLines);
  const durationUs=scene.durationUs??8_000_000;
  const localTimeUs=scene.captionTrack||scene.clipEdit?timeUs:Math.max(0,timeUs);
  const captionDurationUs=scene.captionTrack||scene.clipEdit?durationUs:Math.max(durationUs,localTimeUs+1);
  const cue=captionAtTime({...scene,durationUs:captionDurationUs,sceneDurationUs:scene.sceneDurationUs??durationUs},localTimeUs,pages,scene.clipEditContext);
  const visible=cue?cue.text.split('\n'):[];
  if(visible.length){
    const box=captionBox(layout,visible.length);
    ctx.fillStyle=layout.backgroundColor;ctx.globalAlpha=layout.backgroundOpacity;ctx.beginPath();ctx.roundRect(box.x,box.y,box.width,box.height,Math.max(3,layout.fontSize*.3));ctx.fill();ctx.globalAlpha=1;
    ctx.fillStyle=layout.textColor;
    if(layout.legacy)visible.forEach((lineText,index)=>ctx.fillText(lineText,width/2,box.y+layout.fontSize*1.1+index*layout.lineHeight,width*.8));
    else{ctx.textBaseline='middle';visible.forEach((lineText,index)=>ctx.fillText(lineText,width/2,box.y+layout.paddingY+(index+.5)*layout.lineHeight,layout.textWidth));}
  }
  ctx.restore();
}

/** Captions are painted after the picture transition, as in the FFmpeg export. */
export function drawSceneCaptions(canvas: HTMLCanvasElement, scene: SceneFrame, timeUs = 0): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前环境无法创建视频画布');
  drawCaptions(ctx, scene, canvas.width, canvas.height, timeUs);
}

/** Shared picture rendering for the interactive preview and exported frames. */
export function drawSceneFrame(canvas: HTMLCanvasElement, scene: SceneFrame, timeUs = 0, options: { captions?: boolean; mediaOnly?: boolean } = {}): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前环境无法创建视频画布');
  const width = canvas.width, height = canvas.height;
  const source=clipEditSource(scene,scene.clipEditContext);
  const sceneUs=scene.clipEdit?resolveShotTime({...scene,durationUs:scene.durationUs??8_000_000},scene.clipEditContext,timeUs).sceneUs:timeUs+(scene.sceneInUs??0);
  const sceneDurationUs = scene.sceneDurationUs ?? source?.original.sceneDurationUs ?? source?.original.durationUs ?? scene.durationUs ?? 8_000_000;
  if(scene.sceneTemplate){
    const progress = Math.min(1, Math.max(0, sceneUs / sceneDurationUs));
    const pose = scene.animation?.keyframes?.length ? sampleMotion(scene.animation, sceneUs, sceneDurationUs) : undefined;
    const layout=resolveCaptionLayout(width,height,scene.captionStyle);
    drawSceneTemplate(canvas,scene.sceneTemplate,progress,{fontSize:layout.fontSize,lines:layout.maxLines,bottom:layout.bottom,diagramTop:layout.diagramTop,diagramBottom:layout.diagramBottom},pose);
    if(options.captions !== false)drawCaptions(ctx,scene,width,height,timeUs);
    return;
  }
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  if(scene.image){
    const image=scene.image;
    const sourceWidth='naturalWidth' in image?image.naturalWidth:'videoWidth' in image?image.videoWidth:'displayWidth' in image?image.displayWidth:'width' in image&&typeof image.width==='number'?image.width:width;
    const sourceHeight='naturalHeight' in image?image.naturalHeight:'videoHeight' in image?image.videoHeight:'displayHeight' in image?image.displayHeight:'height' in image&&typeof image.height==='number'?image.height:height;
    const fit=scene.profile.fitMode==='cover'?Math.max(width/sourceWidth,height/sourceHeight):Math.min(width/sourceWidth,height/sourceHeight);
    const mediaPose=options.mediaOnly?{zoom:1,panX:0,panY:0}:sampleMotion(scene.animation,sceneUs,sceneDurationUs,1);
    const zoom=mediaPose.zoom;
    const keyframed=!options.mediaOnly&&Boolean(scene.animation?.keyframes?.length);
    const w=sourceWidth*fit*(keyframed?1:zoom),h=sourceHeight*fit*(keyframed?1:zoom);
    ctx.fillStyle='#1d2724';ctx.fillRect(0,0,width,height);
    if(keyframed){ctx.save();ctx.translate(width/2+mediaPose.panX*width,height/2+mediaPose.panY*height);ctx.scale(zoom,zoom);ctx.translate(-width/2,-height/2);ctx.beginPath();ctx.rect(0,0,width,height);ctx.clip();}
    if(scene.profile.fitMode==='blur'){ctx.save();ctx.filter=`blur(${Math.max(8,width*.02)}px)`;const cover=Math.max(width/sourceWidth,height/sourceHeight);ctx.drawImage(image,(width-sourceWidth*cover)/2,(height-sourceHeight*cover)/2,sourceWidth*cover,sourceHeight*cover);ctx.restore();}
    ctx.drawImage(image,(width-w)/2+(keyframed?0:mediaPose.panX*width),(height-h)/2+(keyframed?0:mediaPose.panY*height),w,h);
    if(keyframed)ctx.restore();
    if (!options.mediaOnly) {
      const titleSize=Math.max(15,Math.min(width*.035,height*.064));
      ctx.textAlign='center';ctx.fillStyle='#374c43';ctx.font=`600 ${titleSize}px "Microsoft YaHei", sans-serif`;
      ctx.fillText(scene.title,width/2,height*.12,width*.82);
      ctx.font=`${Math.max(10,titleSize*.42)}px "Microsoft YaHei", sans-serif`;ctx.fillStyle='#66745b';
      if(scene.label)ctx.fillText(scene.label,width/2,height*.17,width*.85);
    }
  } else if (!options.mediaOnly) drawDefaultPicture(ctx, width, height);
  if(options.captions !== false)drawCaptions(ctx,scene,width,height,timeUs);
  ctx.restore();
}
