import { firstFrameAtUs, timeAtFrame, type FrameRate } from '@video-quickly/contracts';

export interface RenderClipSchedule { index: number; startUs: number; endUs: number; firstFrame: number; endFrame: number; frameCount: number; phaseUs: number }

/** Allocate one global sampling grid, without extending each logical shot independently. */
export function createRenderSchedule(shots: readonly { durationUs: number }[], rate: FrameRate): RenderClipSchedule[] {
  let cursorUs = 0;
  return shots.map((shot, index) => {
    const startUs = cursorUs, endUs = startUs + shot.durationUs;
    const firstFrame = firstFrameAtUs(startUs, rate), endFrame = firstFrameAtUs(endUs, rate);
    cursorUs = endUs;
    return { index, startUs, endUs, firstFrame, endFrame, frameCount: endFrame - firstFrame, phaseUs: timeAtFrame(firstFrame, rate) - startUs };
  });
}
