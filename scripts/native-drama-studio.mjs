import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';

const execute = promisify(execFile);

/** Use the real desktop bridge and isolated sidecar without starting a model request. */
export async function verifyNativeDramaStudio({ page, rpc, openProject, fixture, artifacts, ffmpegPath, environment, checks }) {
  const originalTitle = await page.getByRole('textbox', { name: '项目名称', exact: true }).inputValue();
  const directory = join(fixture, 'drama-studio'), imagePath = join(directory, 'character.png'), appearancePath = join(directory, 'appearance.png'), audioPath = join(directory, 'voice.wav');
  await mkdir(directory, { recursive: true });
  await execute(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x96', '-frames:v', '1', imagePath], { windowsHide: true, env: environment });
  await execute(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', audioPath], { windowsHide: true, env: environment });
  await writeFile(appearancePath, await readFile(imagePath));
  const image = await rpc('asset.import', { path: imagePath, kind: 'image' });
  const appearance = await rpc('asset.import', { path: appearancePath, kind: 'image' });
  const audio = await rpc('asset.import', { path: audioPath, kind: 'audio' });
  const suffix = randomUUID().slice(0, 6);
  const voice = await rpc('voice.save', { voice: { name: `原生主角音色 ${suffix}`, description: '沉稳清晰，保持说话节奏。', language: 'zh-CN', referenceAssetIds: [audio.id] } });
  const narrator = await rpc('voice.save', { voice: { name: `原生解说音色 ${suffix}`, description: '自然叙述，停顿清楚。', language: 'zh-CN', referenceAssetIds: [audio.id] } });
  const character = await rpc('character.save', { character: { name: `原生短剧角色 ${suffix}`, description: '固定人物身份和外形', referenceAssetIds: [image.id], defaultVoiceId: voice.id,
    appearances: [{ id: 'coat', name: '黄色雨衣', description: '黄色雨衣，手持折伞', referenceAssetIds: [appearance.id] }] } });
  const catalog = await rpc('dramaStudio.catalog.get'), topics = (await rpc('dramaTopic.list', { limit: 2 })).items;
  const style = catalog.styles.find(preset => preset.id === 'natural-live-action');
  assert.ok(style && topics.length === 2);
  const work = await rpc('dramaWork.save', { work: { title: `原生短剧作品 ${suffix}`, description: '连续剧集与可复用角色', visualStyle: 'live-action', narrativeMode: 'mixed', characterIds: [character.id],
    topicIds: topics.map(topic => topic.id), stylePresetId: style.id, skillIds: style.skillIds } });
  const episodes = [];
  for (const [index, visualStyle, narrativeMode] of [[1, 'live-action', 'dialogue'], [2, 'animation', 'mixed'], [3, 'animation', 'narration']]) {
    let episode = await rpc('project.create', { title: `原生短剧第 ${index} 集 ${suffix}`, originalText: '第一场 石板巷口 深夜\n人物在路灯下停步，等候来人。', drama: { workId: work.id, number: index, visualStyle, narrativeMode, scenes: [{ id: 'alley', title: '雨夜相遇', description: '人物在路灯下停步', location: '石板巷口', timeOfDay: '深夜' }] } });
    assert.equal(episode.style, visualStyle === style.visualStyle ? style.prompt : '');
    for (const topic of topics) assert.ok(episode.brief.includes(topic.logline));
    for (const node of episode.workflow.nodes.filter(node => ['brief', 'style', 'script'].includes(node.kind))) assert.deepEqual(node.skillIds, style.skillIds);
    episode = await rpc('project.update', { projectId: episode.id, revision: episode.revision, patch: { shots: [{ id: `drama-shot-${index}`, title: '巷口对白', narration: '', visualPrompt: '路灯下的人物看向来人', durationUs: 4_000_000, characterIds: [character.id],
      drama: { sceneId: 'alley', appearances: [{ characterId: character.id, appearanceId: 'coat' }], lines: narrativeMode === 'narration'
        ? [{ id: `narration-${index}`, kind: 'narration', text: '那一夜的雨一直没有停。', voiceId: narrator.id }]
        : [{ id: `dialogue-${index}`, kind: 'dialogue', text: '你终于来了。', speakerId: character.id, emotion: '克制惊讶', pauseAfterUs: 500_000 }] },
    }] } });
    episodes.push(episode);
  }
  const before = await rpc('workspace.snapshot');
  const listed = await rpc('dramaWork.episodes', { workId: work.id });
  assert.deepEqual(listed.map(episode => [episode.drama.number, episode.drama.visualStyle, episode.drama.narrativeMode]), [[1, 'live-action', 'dialogue'], [2, 'animation', 'mixed'], [3, 'animation', 'narration']]);
  assert.deepEqual((await rpc('character.references', { characterId: character.id })).map(asset => asset.id), [image.id, appearance.id]);
  assert.deepEqual((await rpc('voice.references', { voiceId: voice.id })).map(asset => asset.id), [audio.id]);

  await page.getByRole('complementary', { name: '工作空间导航', exact: true }).getByRole('button', { name: '短剧工作室', exact: true }).click();
  const library = page.locator('.drama-library'), back = library.getByRole('button', { name: '短剧工作室', exact: true });
  await expect(library).toBeVisible();
  if (await back.isVisible()) await back.click();
  const filters = library.getByRole('group', { name: '作品筛选', exact: true });
  await expect(filters).toBeVisible();
  await filters.getByRole('button', { name: '可用', exact: true }).click();
  await library.getByLabel('搜索作品', { exact: true }).fill(work.title);
  const card = page.locator('.drama-work-card').filter({ has: page.getByRole('heading', { name: work.title, exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '查看分集', exact: true }).click();
  await expect(page.locator('.drama-episode-row')).toHaveCount(3);
  await expect(page.locator('.drama-episode-row').nth(0)).toContainText('真人写实');
  await expect(page.locator('.drama-episode-row').nth(1)).toContainText('动漫与风格化');
  await expect(page.locator('.drama-episode-row').nth(2)).toContainText('旁白解说');
  await page.screenshot({ path: join(artifacts, 'desktop-drama-episodes.png') });
  await page.locator('.drama-episode-row').filter({ has: page.getByRole('heading', { name: episodes[0].title, exact: true }) }).getByRole('button', { name: '打开分集', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue(episodes[0].title);
  await page.getByRole('button', { name: '场次与对白', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '短剧内容 · 第 1 集', exact: true });
  await expect(editor.getByRole('combobox', { name: '视觉风格', exact: true })).toHaveValue('live-action');
  await expect(editor.getByRole('combobox', { name: '讲述方式', exact: true })).toHaveValue('dialogue');
  await expect(editor.getByRole('combobox', { name: `形象：${character.name}`, exact: true })).toHaveValue('coat');
  await editor.getByRole('combobox', { name: '视觉风格', exact: true }).selectOption('animation');
  await editor.getByRole('combobox', { name: '讲述方式', exact: true }).selectOption('mixed');
  await editor.getByRole('group', { name: '台词 1', exact: true }).getByRole('textbox', { name: '台词正文', exact: true }).fill('雨停之前，我们一起等。');
  await editor.getByRole('button', { name: '添加台词', exact: true }).click();
  const narration = editor.getByRole('group', { name: '台词 2', exact: true });
  await narration.getByRole('combobox', { name: '台词类型', exact: true }).selectOption('narration');
  await narration.getByRole('textbox', { name: '台词正文', exact: true }).fill('他们终于等到了久违的答案。');
  await narration.getByRole('combobox', { name: '台词音色', exact: true }).selectOption(narrator.id);
  await editor.getByRole('button', { name: '保存短剧内容', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const current = async () => (await rpc('project.get', { projectId: episodes[0].id })).project;
  await expect.poll(async () => (await current()).shots[0].drama.lines.map(line => line.text)).toEqual(['雨停之前，我们一起等。', '他们终于等到了久违的答案。']);
  await page.getByRole('button', { name: '场次与对白', exact: true }).click();
  await expect(editor.getByRole('combobox', { name: '视觉风格', exact: true })).toHaveValue('animation');
  await expect(editor.getByRole('combobox', { name: '讲述方式', exact: true })).toHaveValue('mixed');
  await expect(editor.getByRole('group', { name: '台词 1', exact: true }).getByRole('combobox', { name: '说话角色', exact: true })).toHaveValue(character.id);
  await expect(editor.getByRole('group', { name: '台词 2', exact: true }).getByRole('combobox', { name: '台词音色', exact: true })).toHaveValue(narrator.id);
  await expect(editor.getByRole('group', { name: '台词 2', exact: true }).getByRole('textbox', { name: '台词正文', exact: true })).toHaveValue('他们终于等到了久违的答案。');
  await editor.getByRole('group', { name: '台词 2', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, 'desktop-drama-content.png') });
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toHaveCount(0);
  checks.nativeDramaWorkspace = true; checks.nativeDramaDialoguePersistence = true;

  await assert.rejects(rpc('voice.archive', { voiceId: narrator.id, revision: narrator.revision }), /仍有角色或项目对白/);
  await assert.rejects(rpc('character.save', { character: { ...character, appearances: [] } }), /仍被项目镜头使用/);
  await assert.rejects(rpc('asset.delete', { assetId: audio.id }), /正在使用/);
  const saved = await current(), backup = await rpc('project.backup', { projectId: saved.id });
  const manifest = JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 10); assert.deepEqual(manifest.project, saved); assert.equal(manifest.dramaWork.id, work.id);
  assert.deepEqual(new Set(manifest.voices.map(profile => profile.id)), new Set([voice.id, narrator.id]));
  assert.deepEqual(manifest.characters[0].appearances, character.appearances);
  for (const asset of manifest.assets) {
    assert.match(asset.path, /^assets\//);
    const original = [image, appearance, audio].find(value => value.id === asset.id);
    assert.ok(original); assert.deepEqual(await readFile(join(backup.path, asset.path)), await readFile(original.path));
  }
  const after = await rpc('workspace.snapshot');
  assert.equal(after.runs.length, before.runs.length, 'Editing drama metadata must not start a model run');
  checks.nativeDramaReferenceProtection = true; checks.nativeDramaPortableBackup = true;
  await openProject(originalTitle);
}
