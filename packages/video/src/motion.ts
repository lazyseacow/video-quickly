import {
  bootstrap, createSignal, MetaFile, ObjectMetaField, Player, Renderer,
  RendererResult, Stage, tween, ValueDispatcher, Vector2,
  type Exporter, type ExporterClass, type FullSceneDescription, type Project, type RendererSettings,
} from '@motion-canvas/core';
import { makeScene2D, Node } from '@motion-canvas/2d';
import type { FrameSink, SceneFrame } from './index.js';
import { drawSceneFrame, frameCount } from './index.js';

class SceneArtwork extends Node {
  private readonly surface = document.createElement('canvas');
  constructor(private readonly frame: SceneFrame, private readonly timeUs: () => number) {
    super({});this.surface.width=frame.profile.width;this.surface.height=frame.profile.height;
  }
  protected override draw(context: CanvasRenderingContext2D): void {
    drawSceneFrame(this.surface,this.frame,this.timeUs());
    context.drawImage(this.surface,-this.surface.width/2,-this.surface.height/2);
    super.draw(context);
  }
}

function desktopExporter(sink:FrameSink,profile:SceneFrame['profile'],totalFrames:number):ExporterClass{
  return {
    id:'video-quickly/desktop',displayName:'Video Quickly 本地导出',
    meta:()=>new ObjectMetaField('options',{}),
    async create():Promise<Exporter>{
      return {
        async start(){await sink.start(profile,totalFrames);},
        async handleFrame(canvas,frame,_sceneFrame,_sceneName,signal){
          if(signal.aborted)throw new DOMException('导出已取消','AbortError');
          if(frame>=totalFrames)return;
          const context=canvas.getContext('2d',{willReadFrequently:true});
          if(!context)throw new Error('无法读取动画画布');
          await sink.write(new Uint8Array(context.getImageData(0,0,canvas.width,canvas.height).data.buffer),frame);
        },
        async stop(result){if(result!==RendererResult.Success)await sink.abort();},
      };
    },
  };
}

/** Programmatic project bootstrap replaces the development-server scene-loader boundary. */
export function createMotionProject(frames:ReadonlyArray<SceneFrame&{durationUs:number}>,sink?:FrameSink):Project{
  if(!frames.length)throw new Error('至少需要一个动画镜头');
  const descriptions=frames.map((frame,index)=>{
    const description=makeScene2D(function*(view){
      const clock=createSignal(0);
      view.add(new SceneArtwork(frame,clock));
      yield* tween(frame.durationUs/1e6,value=>clock(value*frame.durationUs));
    });
    description.meta.seed.set(29871+index);
    // Player/Renderer supply scene size, playback, variables and logger when instantiating this description.
    return Object.assign(description,{name:`shot-${index}`,plugins:[],onReplaced:new ValueDispatcher(description)}) as unknown as FullSceneDescription;
  });
  const totalFrames=frameCount(frames.reduce((total,frame)=>total+frame.durationUs,0),frames[0].profile.frameRate);
  const plugins=sink?[{name:'video-quickly/exporter',exporters:()=>[desktopExporter(sink,frames[0].profile,totalFrames)]}]:[];
  return bootstrap('Video Quickly',{core:'3.17.2',two:'3.17.2',ui:null,vitePlugin:null},plugins,{scenes:descriptions},new MetaFile('project'),new MetaFile('settings'));
}

export function createMotionPreview(container:HTMLElement,frames:ReadonlyArray<SceneFrame&{durationUs:number}>):{play():void;pause():void;seek(frame:number):void;dispose():void}{
  const project=createMotionProject(frames),profile=frames[0].profile;
  const stage=new Stage();stage.configure({size:new Vector2(profile.width,profile.height),resolutionScale:profile.previewScale,colorSpace:'srgb',background:'#eadfc6'});
  const player=new Player(project,{fps:profile.frameRate.numerator/profile.frameRate.denominator,size:new Vector2(profile.width,profile.height),resolutionScale:profile.previewScale},{paused:true});
  container.replaceChildren(stage.finalBuffer);stage.finalBuffer.style.width='100%';stage.finalBuffer.style.height='100%';stage.finalBuffer.style.objectFit='contain';
  const render=async()=>{if(player.playback.currentScene)await stage.render(player.playback.currentScene,player.playback.previousScene);};
  player.onRender.subscribe(render);
  return {play:()=>player.togglePlayback(true),pause:()=>player.togglePlayback(false),seek:frame=>player.requestSeek(frame),dispose:()=>{player.deactivate();player.onRender.unsubscribe(render);stage.finalBuffer.remove();}};
}

export async function renderMotionVideo(frames:ReadonlyArray<SceneFrame&{durationUs:number}>,sink:FrameSink,signal?:AbortSignal):Promise<string>{
  const project=createMotionProject(frames,sink),profile=frames[0].profile;
  const renderer=new Renderer(project);
  const settings:RendererSettings={name:'Video Quickly',size:new Vector2(profile.width,profile.height),resolutionScale:1,colorSpace:'srgb',background:'#eadfc6',fps:profile.frameRate.numerator/profile.frameRate.denominator,range:[0,Infinity],exporter:{name:'video-quickly/desktop',options:{}}};
  const cancel=()=>renderer.abort();signal?.addEventListener('abort',cancel,{once:true});
  const state:{result:RendererResult}={result:RendererResult.Error};const finished=(value:RendererResult)=>{state.result=value;};renderer.onFinished.subscribe(finished);
  try{await renderer.render(settings);if(state.result!==RendererResult.Success)throw new Error(state.result===RendererResult.Aborted?'动画导出已取消':'动画导出失败');return await sink.finish();}
  finally{signal?.removeEventListener('abort',cancel);renderer.onFinished.unsubscribe(finished);}
}
