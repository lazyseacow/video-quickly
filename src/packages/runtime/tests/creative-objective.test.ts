import { describe, expect, it } from 'vitest';
import { creativeObjectivePlanSchema, type CreativeObjectiveAnalysis } from '@video-quickly/contracts';
import { resolveCreativeObjective } from '../src/creative-objective.js';

const resolve = (goal: string, analysis: Partial<CreativeObjectiveAnalysis> = {}) => creativeObjectivePlanSchema.parse(resolveCreativeObjective({
  id: '00000000-0000-4000-8000-000000000001', goal, modelId: 'model-1',
  analysis: { route: 'storyboard', reason: '按目标交付。', totalSeconds: null, shotCount: null, shotSeconds: null, keyframeShots: null, ...analysis },
}));

describe('creative objective resolution', () => {
  it('extracts a style card without introducing storyboard timing', () => {
    const plan = resolve('只提取风格，参考原片总长 15 秒，画面来自原片第 2 镜，不要再预演第 2 镜。', { route: 'style-only' });
    expect(plan.issues).toEqual([]);
    expect(plan.options).toEqual([{ id: 'original', label: '提取风格卡', shotDurationsUs: [], keyframeShots: [] }]);
  });

  it.each([
    '只提取风格，再生成总长 15 秒的分镜。',
    '只提取风格，并预演第 2 镜。',
  ])('blocks conflicting deliverables even if the model chooses style-only: %s', goal => {
    const plan = resolve(goal, { route: 'style-only' });
    expect(plan.issues).toEqual([expect.stringMatching(/请明确本次要交付/)]);
    expect(plan.options).toEqual([]);
  });

  it.each([
    ['总时长不超过 15 秒', null],
    ['总时长 15 秒以内', 15],
  ])('asks before relaxing fixed durations or the total ceiling: %s', (constraint, totalSeconds) => {
    const plan = resolve(`出分镜，共三镜，${constraint}，单镜时长 5/8/5 秒。`, { totalSeconds, shotSeconds: [5, 5, 5] });
    expect(plan.issues).toEqual([expect.stringMatching(/上限 15 秒.*18 秒/)]);
    expect(plan.options.map(({ id, shotDurationsUs }) => [id, shotDurationsUs])).toEqual([
      ['keep-shots', [5_000_000, 8_000_000, 5_000_000]],
      ['keep-total', [5_000_000, 5_000_000, 5_000_000]],
    ]);
  });

  it('keeps shorter explicit times when the total ceiling is satisfied', () => {
    const plan = resolve('出分镜，共三镜，总时长不超过 15 秒，单镜时长 3/4/5 秒。', { totalSeconds: 15 });
    expect(plan.issues).toEqual([]);
    expect(plan.options[0].shotDurationsUs).toEqual([3_000_000, 4_000_000, 5_000_000]);
  });

  it('adjusts only unspecified durations when the total ceiling permits it', () => {
    const plan = resolve('出分镜，共三镜，总时长 15 秒以下，第二镜 7 秒。');
    expect(plan.issues).toEqual([]);
    expect(plan.options[0].shotDurationsUs).toEqual([4_000_000, 7_000_000, 4_000_000]);
  });

  it.each(['总时长至少 15 秒', '总时长 15 秒以上'])('asks before relaxing fixed durations or the total floor: %s', constraint => {
    const plan = resolve(`出分镜，共三镜，${constraint}，单镜时长 3/4/5 秒。`);
    expect(plan.issues).toEqual([expect.stringMatching(/下限 15 秒.*12 秒/)]);
    expect(plan.options.map(({ id, shotDurationsUs }) => [id, shotDurationsUs])).toEqual([
      ['keep-shots', [3_000_000, 4_000_000, 5_000_000]],
      ['keep-total', [6_000_000, 4_000_000, 5_000_000]],
    ]);
  });

  it.each([
    '沿用参考风格出分镜，共三段，总长十五秒，首尾各五秒，第二段八秒。',
    '沿用参考风格出分镜，共3个镜头，总长15秒，时长分别为 5/8/5 秒。',
  ])('preserves conflicting exact values even when the model smooths timing: %s', goal => {
    const plan = resolve(goal, { totalSeconds: 15, shotCount: 3, shotSeconds: [5, 5, 5] });
    expect(plan.issues).toEqual([expect.stringMatching(/15 秒.*18 秒/)]);
    expect(plan.options.map(({ id, shotDurationsUs }) => [id, shotDurationsUs])).toEqual([
      ['keep-shots', [5_000_000, 8_000_000, 5_000_000]],
      ['keep-total', [5_000_000, 5_000_000, 5_000_000]],
    ]);
  });

  it('distributes only unspecified shot durations and keeps the exact total', () => {
    const plan = resolve('全片 10.000001 秒，分成三镜，第二镜 4 秒。');
    expect(plan.issues).toEqual([]);
    expect(plan.options[0].shotDurationsUs).toEqual([3_000_001, 4_000_000, 3_000_000]);
  });

  it('keeps an event offset distinct from shot duration', () => {
    const plan = resolve('分为两镜，总长 20 秒，第二镜 5 秒后出现字幕。');
    expect(plan.issues).toEqual([]);
    expect(plan.options[0].shotDurationsUs).toEqual([10_000_000, 10_000_000]);
  });

  it('keeps a narrative offset distinct from a total boundary', () => {
    const plan = resolve('分为两镜，全片 15 秒以后出现字幕。');
    expect(plan.issues).toEqual([]);
    expect(plan.options[0].shotDurationsUs).toEqual([5_000_000, 5_000_000]);
  });

  it('adapts the default shot count when the total is the only timing constraint', () => {
    const plan = resolve('用这个风格做总时长 0.5 秒的分镜。');
    expect(plan.issues).toEqual([]);
    expect(plan.options[0].shotDurationsUs).toEqual([500_000]);
  });

  it.each([
    ['出分镜，共 101 镜。', /镜头数量 101/],
    ['出分镜，第二镜 0.4 秒。', /第 2 镜.*0.4 秒/],
    ['出分镜，共三镜，第四镜五秒。', /与 3 个镜头不一致/],
    ['出分镜，总时长 -3 秒。', /总时长 -3 秒/],
    ['出分镜，总时长十二秒、全片时长十五秒。', /指定了多个总时长/],
    ['出分镜，总时长至少 20 秒、总时长不超过 15 秒。', /总时长要求互相冲突/],
    ['出分镜，总时长 20 秒、总时长不超过 15 秒。', /总时长要求互相冲突/],
    ['出分镜，总时长不超过 0.4 秒。', /边界超出可制作范围/],
  ])('blocks unsupported or contradictory constraints before generation: %s', (goal, issue) => {
    const plan = resolve(goal);
    expect(plan.issues).toEqual([expect.stringMatching(issue)]);
    expect(plan.options).toEqual([]);
  });

  it('offers the supported alternative when total timing cannot fit in the given shot count', () => {
    const plan = resolve('共两个镜头，总长一秒，第一镜五秒。');
    expect(plan.issues).toEqual([expect.stringMatching(/1 秒.*10 秒/)]);
    expect(plan.options.map(({ id, shotDurationsUs }) => [id, shotDurationsUs])).toEqual([
      ['keep-shots', [5_000_000, 5_000_000]],
      ['keep-total', [500_000, 500_000]],
    ]);
    const impossible = resolve('共两个镜头，总长 0.5 秒。');
    expect(impossible.issues).toHaveLength(1);
    expect(impossible.options.map(option => option.id)).toEqual(['keep-shots']);
  });

  it('supports first and last or explicitly chosen keyframes with one-based numbering', () => {
    const defaults = resolve('预演关键镜头。', { route: 'keyframe-preview', shotCount: 4 });
    const singleton = resolve('预演唯一的镜头。', { route: 'keyframe-preview', shotCount: 1 });
    const explicit = resolve('预演第六个镜头。', { route: 'keyframe-preview', keyframeShots: [6] });
    expect(defaults.options[0].keyframeShots).toEqual([1, 4]);
    expect(singleton.options[0].keyframeShots).toEqual([1]);
    expect(explicit.options[0].keyframeShots).toEqual([6]);
    expect(explicit.options[0].shotDurationsUs).toHaveLength(6);
  });

  it('preserves named keyframe indices so normalized model indices cannot bypass confirmation', () => {
    const plan = resolve('预演第 1 镜和第 4 镜，共三镜。', { route: 'keyframe-preview', keyframeShots: [1, 3] });
    expect(plan.issues).toEqual([expect.stringMatching(/1 至 3/)]);
    expect(plan.options).toEqual([]);
  });

  it.each([[0], [4], [1, 1], [1, 2, 3, 4], []].map(indices => ({ indices })))('blocks invalid keyframe indices $indices', ({ indices }) => {
    const plan = resolve('预演指定镜头，分成三镜。', { route: 'keyframe-preview', shotCount: 3, keyframeShots: indices });
    expect(plan.issues).toEqual([expect.stringMatching(/编号各不相同/)]);
    expect(plan.options).toEqual([]);
  });
});
