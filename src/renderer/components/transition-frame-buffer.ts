export interface TransitionFrameSample { frame: number; timeUs: number }
export interface BufferedTransitionFrame { canvas: HTMLCanvasElement; width: number; height: number }

const MAX_BUFFER_PIXELS = 48 * 1024 * 1024 / 4;

/** One pinned prefix, owned by the existing scene decoder and released after its transition. */
export class TransitionFrameBuffer {
  private frames = new Map<number, BufferedTransitionFrame>();
  constructor(readonly samples: readonly TransitionFrameSample[], private createCanvas = () => document.createElement('canvas'), private pixelBudget = MAX_BUFFER_PIXELS) {}

  get ready() { return this.frames.size === this.samples.length; }
  get nextSample() { return this.samples.find(sample => !this.frames.has(sample.frame)); }
  get retainedPixels() { return [...this.frames.values()].reduce((sum, frame) => sum + frame.canvas.width * frame.canvas.height, 0); }
  get(frame: number) { return this.frames.get(frame); }

  capture(frame: number, source: HTMLCanvasElement) {
    if (this.nextSample?.frame !== frame || !source.width || !source.height) return false;
    const scale = Math.min(1, Math.sqrt(this.pixelBudget / this.samples.length / (source.width * source.height)));
    const canvas = this.createCanvas();
    canvas.width = Math.max(1, Math.floor(source.width * scale)); canvas.height = Math.max(1, Math.floor(source.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境无法准备转场画面');
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    this.frames.set(frame, { canvas, width: source.width, height: source.height });
    return true;
  }

  clear() {
    for (const frame of this.frames.values()) frame.canvas.width = frame.canvas.height = 0;
    this.frames.clear();
  }
}
