import { describe, expect, it } from 'vitest';
import { buildTimeline, captionPages, createSrt, createTimedSrt, createSubtitleCues, frameCount, frameTimeUs } from '../src/index.js';

describe('video timing',()=>{
  it('preserves complete narration and microsecond clip duration in exported subtitles',()=>{
    const shots=[{id:'a',durationUs:1_301_300,narration:'第一句完整旁白。'},{id:'b',durationUs:2_002_000,narration:'第二句完整旁白。'}];
    expect(buildTimeline(shots)[1]).toMatchObject({startUs:1_301_300,endUs:3_303_300});
    expect(createSrt(shots)).toContain('00:00:01,301 --> 00:00:03,303\n第二句完整旁白。');
  });
  it('uses exact rational frames without creating a spurious frame after microsecond rounding',()=>{
    const rate={numerator:30_000,denominator:1001};
    expect(frameTimeUs(39,rate)).toBe(1_301_300);
    expect(frameCount(frameTimeUs(39,rate),rate)).toBe(39);
    expect(frameCount(frameTimeUs(40,rate),rate)).toBe(40);
    expect(frameCount(1_300_000,rate)).toBe(39);
  });
  it('keeps the tail of long narration visible in timed subtitle pages',()=>{
    const narration='第一句很长需要分开显示。最后一句也必须完整保留。';
    const pages=captionPages(narration,text=>text.length,7,2);
    expect(pages.flat().join('')).toBe(narration);
    const srt=createTimedSrt([{id:'long',durationUs:4_000_000,narration}],()=>pages);
    expect(srt).toContain('00:00:04,000');
    expect(srt.replaceAll('\n','')).toContain('完整保留。');
  });
  it('keeps the original caption timing through splits and crops a trimmed source interval', () => {
    const original = { id: 'scene', durationUs: 4_000_000, narration: '第一句。第二句。' };
    const pages = () => [['第一句。'], ['第二句。']];
    const split = [
      { ...original, id: 'left', durationUs: 1_500_000, sceneInUs: 0, sceneDurationUs: 4_000_000 },
      { ...original, id: 'right', durationUs: 2_500_000, sceneInUs: 1_500_000, sceneDurationUs: 4_000_000 },
    ];
    expect(createTimedSrt(split, pages)).toBe(createTimedSrt([original], pages));
    expect(createSrt(split)).toBe(createSrt([original]));
    expect(createSubtitleCues([{ ...original, durationUs: 1_000_000, sceneInUs: 2_500_000, sceneDurationUs: 4_000_000 }], pages)).toEqual([{ startUs: 0, endUs: 1_000_000, lines: ['第二句。'] }]);
    expect(createSubtitleCues([{ ...original, durationUs: 1_000_000, sceneInUs: 5_000_000, sceneDurationUs: 4_000_000 }], pages)).toEqual([{ startUs: 0, endUs: 1_000_000, lines: ['第二句。'] }]);
  });
});
