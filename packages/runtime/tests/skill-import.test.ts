import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { type WorkspaceSnapshot } from '@video-quickly/contracts';
import { createRuntime } from '../src/index.js';
import { importSkillFixture } from '../../../tests/fixtures/import-skill';

const directories: string[] = [];
const runtimes: ReturnType<typeof createRuntime>[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-skill-import-'));
  directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory });
  runtimes.push(runtime);
  return { directory, runtime };
}

function repositoryZip() {
  return zipSync({
    ...Object.fromEntries(Array.from({ length: 510 }, (_, index) => [`drama-main/examples/${index}.md`, strToU8('example')])),
    'drama-main/skills/write/SKILL.md': strToU8('---\nname: drama-write\ndescription: 写作方法\n---\n读取 references/guide.md。'),
    'drama-main/skills/write/references/guide.md': strToU8('写作资源'),
    'drama-main/skills/write/scripts/check.mjs': strToU8('process.stdout.write("ready")'),
    'drama-main/skills/storyboard/SKILL.md': strToU8('---\nname: drama-storyboard\ndescription: 分镜方法\n---\n生成分镜。'),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('Skill repository import', () => {
  it('imports a local Skill collection into one source group', async () => {
    const { directory, runtime } = await fixture();
    const path = join(directory, 'local-collection');
    for (const name of ['writing', 'visual-style']) {
      const root = join(path, 'skills', name); await mkdir(root, { recursive: true });
      await writeFile(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: 创作方法\n---\n使用对应方法完成当前任务。`);
    }
    const result = await importSkillFixture(runtime.dispatch, { path });
    expect(result.skills.map(skill => skill.name)).toEqual(['visual-style', 'writing']);
    expect(result.group.name).toBe('local-collection');
  });
  it('imports every Skill into one group while applying limits per Skill', async () => {
    const { directory, runtime } = await fixture();
    const path = join(directory, 'repository.zip');
    await writeFile(path, repositoryZip());

    const batch = await importSkillFixture(runtime.dispatch, { path });
    expect(batch.skills.map(skill => skill.name)).toEqual(['drama-storyboard', 'drama-write']);
    expect(batch.group.name).toBe('repository');
    expect(batch.group.skillIds).toEqual(batch.skills.map(skill => skill.id));
    const skill = batch.skills.find(skill => skill.name === 'drama-write')!;
    expect(skill.resources).toEqual(['references/guide.md', 'scripts/check.mjs']);
    expect(skill.tools[0].enabled).toBe(false);
    expect(await readFile(join(directory, 'skills', skill.id, 'references/guide.md'), 'utf8')).toBe('写作资源');
    const snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(snapshot.skills).toHaveLength(2);
    expect(snapshot.skillGroups).toEqual([batch.group]);
    expect(await readdir(join(directory, 'imports'))).toEqual([]);
    await expect(importSkillFixture(runtime.dispatch, { path, skillPath: '../skills/write' })).rejects.toThrow('所选 Skill');
  });

  it('imports a specific GitHub Skill directory from a repository with more than 500 files', async () => {
    const { runtime } = await fixture();
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      requests.push(String(input));
      return new Response(repositoryZip(), { status: 200 });
    });
    const url = 'https://github.com/fixture/drama/tree/main/skills/write';
    const skill = (await importSkillFixture(runtime.dispatch, { url })).skills[0];
    expect(skill.name).toBe('drama-write');
    expect(skill.source).toBe(url);
    expect(requests).toEqual(['https://codeload.github.com/fixture/drama/zip/refs/heads/main']);
  });

  it('accepts a .git repository URL and imports the whole repository group', async () => {
    const { runtime } = await fixture();
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      requests.push(url);
      return url.startsWith('https://api.github.com/')
        ? Response.json({ default_branch: 'main' })
        : new Response(repositoryZip(), { status: 200 });
    });
    const result = await importSkillFixture(runtime.dispatch, { url: 'https://github.com/fixture/drama.git' });
    expect(result.skills).toHaveLength(2); expect(result.group.name).toBe('drama');
    expect(requests).toEqual(['https://api.github.com/repos/fixture/drama', 'https://codeload.github.com/fixture/drama/zip/refs/heads/main']);
  });

  it('retains the 500-file limit for a selected Skill', async () => {
    const { directory, runtime } = await fixture();
    const path = join(directory, 'oversized.zip');
    await writeFile(path, zipSync({
      'write/SKILL.md': strToU8('---\nname: drama-write\ndescription: 写作方法\n---\n生成剧本。'),
      ...Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`write/references/${index}.md`, strToU8('resource')])),
    }));
    await expect(importSkillFixture(runtime.dispatch, { path })).rejects.toThrow('500');
    expect((await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot).skills).toHaveLength(0);
  });
});
