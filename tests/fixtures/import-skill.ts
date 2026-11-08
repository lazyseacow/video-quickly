import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { skillImportJobSchema, workspaceSummarySchema, type SkillImportSource } from '@video-quickly/contracts';

export async function importSkillFixture(rpc: (method: string, params: unknown) => Promise<unknown>, source: SkillImportSource) {
  let job = skillImportJobSchema.parse(await rpc('skill.import.start', { source, requestId: randomUUID() }));
  const deadline = Date.now() + 15_000;
  while ((job.status === 'queued' || job.status === 'running') && Date.now() < deadline) {
    await delay(20);
    job = skillImportJobSchema.parse(await rpc('skill.import.get', { id: job.id }));
  }
  if (job.status !== 'succeeded') throw new Error(job.error ?? `Skill fixture import did not finish (${job.status})`);
  const workspace = workspaceSummarySchema.parse(await rpc('workspace.summary', {}));
  const group = workspace.skillGroups?.find(item => item.id === job.groupId);
  assert.ok(group, 'The completed import must have a group');
  const skills = job.skillIds.map(id => {
    const skill = workspace.skills.find(item => item.id === id);
    assert.ok(skill, 'The completed import must publish each Skill');
    return skill;
  });
  return { group, skills };
}
