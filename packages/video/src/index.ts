import type { FrameRate, Shot, VideoProfile } from '@video-quickly/contracts';

export interface TimelineClip { shotId: string; index: number; startUs: number; durationUs: number; endUs: number }
export interface SceneFrame { title: string; narration: string; shotIndex: number; profile: VideoProfile; durationUs?: number; animation?: Shot['animation']; image?: CanvasImageSource; label?: string; sample?: boolean }

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

export function createSrt(shots: ReadonlyArray<Pick<Shot, 'id' | 'durationUs' | 'narration'>>): string {
  const clips = buildTimeline(shots);
  return clips.flatMap((clip, index) => {
    const text = shots[index].narration.trim();
    return text ? [`${index + 1}\n${timestamp(clip.startUs)} --> ${timestamp(clip.endUs)}\n${text}\n`] : [];
  }).join('\n');
}

export function captionPages(text:string,measure:(text:string)=>number,width:number,maxLines:number):string[][]{
  const lines:string[]=[];let current='';
  for(const character of text.trim()){
    if(character==='\n'){if(current)lines.push(current);current='';continue;}
    if(current&&measure(current+character)>width){lines.push(current);current=character;}else current+=character;
  }
  if(current)lines.push(current);
  return Array.from({length:Math.ceil(lines.length/maxLines)},(_,index)=>lines.slice(index*maxLines,(index+1)*maxLines));
}

export function createTimedSrt(shots:ReadonlyArray<Pick<Shot,'id'|'durationUs'|'narration'>>,pages:(text:string)=>string[][]):string{
  const clips=buildTimeline(shots);let sequence=0;
  return clips.flatMap((clip,index)=>{
    const blocks=pages(shots[index].narration);
    return blocks.map((lines,page)=>`${++sequence}\n${timestamp(clip.startUs+Math.round(clip.durationUs*page/blocks.length))} --> ${timestamp(clip.startUs+Math.round(clip.durationUs*(page+1)/blocks.length))}\n${lines.join('\n')}\n`);
  }).join('\n');
}

function polygon(ctx: CanvasRenderingContext2D, points: number[][], fill: string, stroke?: string) {
  ctx.beginPath();
  points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2.2; ctx.stroke(); }
}

function line(ctx: CanvasRenderingContext2D, points: number[][], color: string, width = 2) {
  ctx.beginPath(); points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
}

function tree(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  line(ctx, [[0, 0], [6, -86], [3, -129]], '#454c3c', 5);
  line(ctx, [[5, -73], [-25, -100], [-43, -117]], '#454c3c', 3);
  line(ctx, [[5, -91], [30, -121], [48, -134]], '#454c3c', 3);
  for (const [cx, cy, r] of [[-42,-117,28],[-10,-135,34],[28,-139,31],[51,-129,22],[-24,-101,25],[19,-111,29]]) {
    ctx.beginPath(); ctx.ellipse(cx, cy, r, r * .65, -.2, 0, Math.PI * 2); ctx.fillStyle = '#728876bb'; ctx.fill();
  }
  ctx.restore();
}

function scholar(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  polygon(ctx, [[-26,0],[-20,-67],[0,-79],[21,-65],[30,0]], '#799696', '#3e504b');
  polygon(ctx, [[-21,-65],[-42,-27],[-28,-18],[-10,-52]], '#9aaf9b', '#3e504b');
  polygon(ctx, [[17,-64],[39,-30],[23,-20],[8,-51]], '#9aaf9b', '#3e504b');
  ctx.fillStyle='#e2c29b';ctx.beginPath();ctx.ellipse(0,-93,17,20,0,0,Math.PI*2);ctx.fill();
  polygon(ctx, [[-19,-107],[-11,-124],[12,-124],[20,-108]], '#394b46');
  line(ctx,[[-14,-109],[14,-109]],'#394b46',7);
  line(ctx,[[-9,1],[-12,8]],'#3b4b44',7);line(ctx,[[13,1],[17,8]],'#3b4b44',7);
  polygon(ctx,[[-18,-54],[13,-59],[24,-35],[-8,-29]],'#e9d6ad','#785d45');
  ctx.restore();
}

/** Deterministic authored sample art shared by interactive preview and exported frames. */
export function drawSceneFrame(canvas: HTMLCanvasElement, scene: SceneFrame, timeUs = 0): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前环境无法创建视频画布');
  const width = canvas.width, height = canvas.height;
  const vertical = height > width;
  ctx.save(); ctx.clearRect(0, 0, width, height);
  const scale = Math.max(width / 960, height / 540);
  ctx.translate((width - 960 * scale) / 2, (height - 540 * scale) / 2); ctx.scale(scale, scale);
  ctx.fillStyle='#eadfc6';ctx.fillRect(0,0,960,540);
  const sky=ctx.createLinearGradient(0,0,0,540);sky.addColorStop(0,'#e5dcc8');sky.addColorStop(.65,'#f2e9d0');sky.addColorStop(1,'#d7d4b5');ctx.fillStyle=sky;ctx.fillRect(0,0,960,540);
  // Fixed arithmetic texture avoids random flicker and makes frames reproducible.
  ctx.fillStyle='#7867440a';
  for(let i=0;i<420;i++){ const x=(i*137.51)%960,y=(i*89.23)%540;ctx.fillRect(x,y,1+(i%3),1); }
  const progress=Math.min(1,Math.max(0,timeUs/(scene.durationUs??8_000_000)));
  const eased=progress*progress*(3-2*progress);
  const animation=scene.animation;
  const zoom=1+((animation?.zoom??1.04)-1)*eased;
  ctx.translate(480,270);ctx.scale(zoom,zoom);ctx.translate(-480+(animation?.panX??0)*960*eased,-270+(animation?.panY??0)*540*eased);
  ctx.globalAlpha=.55;
  polygon(ctx,[[0,285],[93,175],[163,235],[267,124],[375,245],[458,162],[563,250],[654,135],[774,240],[875,172],[960,263],[960,420],[0,420]],'#aab6a2');
  polygon(ctx,[[0,325],[109,246],[194,281],[297,205],[430,306],[527,219],[678,312],[796,223],[960,308],[960,440],[0,440]],'#899d8b');
  ctx.globalAlpha=1;
  polygon(ctx,[[0,399],[167,353],[342,385],[519,347],[674,383],[854,354],[960,394],[960,540],[0,540]],'#b7bd98');
  polygon(ctx,[[0,447],[176,411],[317,445],[493,399],[692,443],[880,415],[960,444],[960,540],[0,540]],'#cad0ac');
  const ox=scene.shotIndex%2===0?0:-45;
  ctx.save();ctx.translate(ox,0);
  polygon(ctx,[[350,373],[350,259],[594,259],[594,373]],'#d7c39a','#6f6750');
  polygon(ctx,[[331,275],[369,232],[573,232],[613,275]],'#5f7365','#495d50');
  polygon(ctx,[[360,232],[397,211],[546,211],[581,232]],'#718575','#495d50');
  for(let x=369;x<590;x+=38){line(ctx,[[x,278],[x,369]],'#805f43',6);ctx.fillStyle='#ac8b64';ctx.fillRect(x+9,295,17,48);}
  polygon(ctx,[[335,371],[610,371],[632,386],[316,386]],'#c4b08a','#84775d');
  line(ctx,[[331,389],[615,389]],'#928061',2);
  for(let i=0;i<5;i++){line(ctx,[[368+i*39,247],[578-i*7,247]],'#425b4c55',1);}
  ctx.restore();
  polygon(ctx,[[398,540],[476,390],[521,390],[564,540]],'#e0d0aa');
  line(ctx,[[396,536],[474,393]],'#b6a47c',1.5);line(ctx,[[565,536],[520,393]],'#b6a47c',1.5);
  tree(ctx,186,424,.98);tree(ctx,787,421,1.2);tree(ctx,855,419,.7);
  scholar(ctx,442+Math.sin(scene.shotIndex)*32,451,vertical?.7:.82);
  scholar(ctx,570,426,.58);
  ctx.restore();
  ctx.save();
  if(scene.image){
    const image=scene.image;
    const sourceWidth='naturalWidth' in image?image.naturalWidth:'videoWidth' in image?image.videoWidth:'displayWidth' in image?image.displayWidth:'width' in image&&typeof image.width==='number'?image.width:width;
    const sourceHeight='naturalHeight' in image?image.naturalHeight:'videoHeight' in image?image.videoHeight:'displayHeight' in image?image.displayHeight:'height' in image&&typeof image.height==='number'?image.height:height;
    const fit=scene.profile.fitMode==='cover'?Math.max(width/sourceWidth,height/sourceHeight):Math.min(width/sourceWidth,height/sourceHeight);
    const zoom=1+((scene.animation?.zoom??1)-1)*eased;
    const w=sourceWidth*fit*zoom,h=sourceHeight*fit*zoom;
    ctx.fillStyle='#1d2724';ctx.fillRect(0,0,width,height);
    if(scene.profile.fitMode==='blur'){ctx.save();ctx.filter=`blur(${Math.max(8,width*.02)}px)`;const cover=Math.max(width/sourceWidth,height/sourceHeight);ctx.drawImage(image,(width-sourceWidth*cover)/2,(height-sourceHeight*cover)/2,sourceWidth*cover,sourceHeight*cover);ctx.restore();}
    ctx.drawImage(image,(width-w)/2+(scene.animation?.panX??0)*width*eased,(height-h)/2+(scene.animation?.panY??0)*height*eased,w,h);
  }
  const titleSize=Math.max(15,Math.min(width*.035,height*.064));
  ctx.textAlign='center';ctx.fillStyle='#374c43';ctx.font=`600 ${titleSize}px "Microsoft YaHei", sans-serif`;
  const title=scene.title;
  ctx.fillText(title,width/2,height*.12,width*.82);
  ctx.font=`${Math.max(10,titleSize*.42)}px "Microsoft YaHei", sans-serif`;ctx.fillStyle='#66745b';
  if(scene.label)ctx.fillText(scene.label,width/2,height*.17,width*.85);
  const caption=scene.narration.trim();
  if(caption){
    const fontSize=Math.max(12,Math.min(width*.027,height*.047));
    ctx.font=`500 ${fontSize}px "Microsoft YaHei", sans-serif`;
    const groupSize=vertical?3:2;
    const chunks=captionPages(caption,text=>ctx.measureText(text).width,width*.78,groupSize);
    const visible=chunks[Math.min(chunks.length-1,Math.floor(progress*chunks.length))]??[],lineHeight=fontSize*1.55;
    const bottom=height*.9,boxHeight=visible.length*lineHeight+fontSize;
    ctx.fillStyle='#20382ee6';ctx.beginPath();ctx.roundRect(width*.07,bottom-boxHeight,width*.86,boxHeight,Math.max(3,fontSize*.3));ctx.fill();
    ctx.fillStyle='#fbf4e1';visible.forEach((lineText,index)=>ctx.fillText(lineText,width/2,bottom-boxHeight+fontSize*1.1+index*lineHeight,width*.8));
  }
  ctx.restore();
}

export interface FrameSink {
  start(profile: VideoProfile, totalFrames: number): Promise<void>;
  write(frame: Uint8Array, frameIndex: number): Promise<void>;
  finish(): Promise<string>;
  abort(): Promise<void>;
}

export async function exportCanvasVideo(
  scenes: ReadonlyArray<SceneFrame & { durationUs: number }>,
  sink: FrameSink,
  options: { signal?: AbortSignal; onProgress?: (value: number) => void } = {},
): Promise<string> {
  if(!scenes.length)throw new Error('至少需要一个镜头');
  const profile=scenes[0].profile;
  const timeline=buildTimeline(scenes.map((scene,index)=>({id:String(index),durationUs:scene.durationUs})));
  const totalFrames=frameCount(timeline.at(-1)!.endUs,profile.frameRate);
  const canvas=document.createElement('canvas');canvas.width=profile.width;canvas.height=profile.height;
  const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('无法创建导出画布');
  await sink.start(profile,totalFrames);
  try{
    for(let frame=0;frame<totalFrames;frame++){
      if(options.signal?.aborted)throw new DOMException('导出已取消','AbortError');
      const timeUs=frameTimeUs(frame,profile.frameRate);
      const clip=timeline.find(clip=>timeUs<clip.endUs)??timeline.at(-1)!;
      drawSceneFrame(canvas,scenes[clip.index],timeUs-clip.startUs);
      await sink.write(new Uint8Array(context.getImageData(0,0,canvas.width,canvas.height).data.buffer),frame);
      options.onProgress?.((frame+1)/totalFrames);
      if(frame%6===0)await new Promise<void>(resolve=>setTimeout(resolve,0));
    }
    return await sink.finish();
  }catch(error){await sink.abort();throw error;}
}
