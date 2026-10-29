import { writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { DEFAULT_AUDIO_MIX_SETTINGS, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';

async function rpc<T>(request: APIRequestContext, method: string, params: unknown = {}): Promise<T> {
  const response = await request.post('/__desktop_rpc', { data: { method, params } });
  const body = await response.json(); expect(response.ok()).toBe(true); expect(body.error).toBeUndefined(); return body.result;
}
async function saved(request: APIRequestContext, projectId: string) { return (await rpc<{ project: ProjectDocument }>(request, 'project.get', { projectId })).project; }
async function writeVoice(path: string) {
  const rate = 16_000, samples = rate * 3, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(index * Math.PI * 880 / rate) * 6000), 44 + index * 2);
  await writeFile(path, data);
}
async function fixture(request: APIRequestContext, info: TestInfo, title: string, third = false) {
  let project = await rpc<ProjectDocument>(request, 'project.create', { title });
  const path = info.outputPath('legacy-prefix-voice.wav'); await writeVoice(path);
  const asset = await rpc<AssetRecord>(request, 'asset.import', { projectId: project.id, path, kind: 'audio' }); project = await saved(request, project.id);
  project = await rpc<ProjectDocument>(request, 'project.update', { projectId: project.id, revision: project.revision, patch: {
    profile: { ...project.profile, width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 } },
    audioMix: { ...DEFAULT_AUDIO_MIX_SETTINGS, loudness: { ...DEFAULT_AUDIO_MIX_SETTINGS.loudness, enabled: false } },
    shots: [
      { id: 'legacy-a', title: '前置完整旁白 A', narration: '', visualPrompt: '', durationUs: 1_000_000, audioAssetId: asset.id },
      { id: 'target-b', title: '目标镜头 B', narration: '', visualPrompt: '', durationUs: 1_000_000 },
      ...(third ? [{ id: 'following-c', title: '后续镜头 C', narration: '', visualPrompt: '', durationUs: 1_000_000 }] : []),
    ],
  } });
  return { project, asset };
}
async function open(page: Page, project: ProjectDocument) {
  await page.goto('/'); await expect(page).toHaveTitle(/Video Quickly/);
  await page.getByRole('button', { name: `打开项目：${project.title}`, exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('前置完整旁白 A'); await ready(page);
}
async function ready(page: Page) {
  await expect(page.locator('.preview-panel .prepared-mix-preview')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.getByRole('button', { name: '播放预览', exact: true })).toBeEnabled();
}
async function seek(page: Page, frames: number) {
  const ruler = page.getByRole('slider', { name: '预览播放位置', exact: true }); await ruler.press('Home');
  for (let index = 0; index < Math.floor(frames / 10); index++) await ruler.press('Shift+ArrowRight');
  for (let index = 0; index < frames % 10; index++) await ruler.press('ArrowRight');
  await expect(ruler).toHaveAttribute('aria-valuenow', String(Math.round(frames * 1000 / 30)));
}
async function selectB(page: Page) {
  await page.getByRole('button', { name: '定位镜头 2：目标镜头 B', exact: true }).click();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('目标镜头 B');
  await expect(page.getByRole('slider', { name: '预览播放位置', exact: true })).toHaveAttribute('aria-valuenow', '3000');
}
async function expectClock(page: Page, milliseconds: number) {
  await expect(page.getByRole('slider', { name: '预览播放位置', exact: true })).toHaveAttribute('aria-valuenow', String(milliseconds));
  await expect.poll(() => page.locator('.preview-panel audio[data-audio-role="处理后混音"]').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeCloseTo(milliseconds / 1000, 2);
}
async function gateFirstSave(page: Page) {
  let release!: () => void, entered!: () => void, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/__desktop_rpc', async route => {
    if (route.request().postDataJSON()?.method === 'project.update' && ++writes === 1) { entered(); await gate; }
    await route.continue();
  });
  return { release, started, writes: () => writes };
}
function observe(page: Page) { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); return errors; }
async function healthy(page: Page, errors: string[]) { expect(errors).toEqual([]); await expect(page.locator('vite-error-overlay')).toHaveCount(0); }

test('splits a following shot at its real mixed prefix without persisting an unrelated legacy duration', async ({ page, request }, info) => {
  const errors = observe(page), { project } = await fixture(request, info, '真实旁白前缀后的分割定位验收'); await open(page, project); await selectB(page); await seek(page, 105);
  await page.getByRole('button', { name: '在播放头处分割镜头', exact: true }).click();
  await expect.poll(async () => (await saved(request, project.id)).shots.length).toBe(3); const result = await saved(request, project.id);
  expect(result.shots.map(shot => shot.durationUs)).toEqual([1_000_000, 500_000, 500_000]);
  expect(result.shots[0].sourceInUs).toBeUndefined(); expect(result.shots[2].sourceInUs).toBe(500_000);
  await ready(page); await expectClock(page, 3500); await healthy(page, errors);
});

test('rejects a split if its target is locked while the preceding save is pending and keeps the new draft', async ({ page, request }, info) => {
  const errors = observe(page), { project } = await fixture(request, info, '分割等待保存期间锁定保护验收'); await open(page, project); await selectB(page); await seek(page, 105);
  await page.getByLabel('镜头标题', { exact: true }).fill('开始分割前的标题'); const gate = await gateFirstSave(page);
  try {
    await page.getByRole('button', { name: '在播放头处分割镜头', exact: true }).click(); await gate.started;
    await page.getByRole('button', { name: '锁定镜头', exact: true }).click(); await expect(page.getByRole('button', { name: '解锁镜头', exact: true })).toBeVisible(); gate.release();
    await expect(page.getByRole('alert').filter({ hasText: /锁定|时间|素材|变化|修改/ })).toBeVisible();
    await expect(page.locator('#project-outline .outline-shot')).toHaveCount(2); await expect(page.locator('.project-heading-copy')).toContainText('未保存');
    const firstSaved = await saved(request, project.id); expect(firstSaved.shots).toHaveLength(2); expect(firstSaved.shots[1].title).toBe('开始分割前的标题'); expect(firstSaved.shots[1].locked).toBe(false); expect(gate.writes()).toBe(1);
    const save = page.getByRole('button', { name: '保存修改', exact: true }); await expect(save).toBeEnabled(); await save.click();
    await expect.poll(async () => (await saved(request, project.id)).shots[1].locked).toBe(true); expect((await saved(request, project.id)).shots).toHaveLength(2); expect(gate.writes()).toBe(2); await healthy(page, errors);
  } finally { gate.release(); }
});

test('locates an added shot after the complete legacy voice without changing the old authored timing', async ({ page, request }, info) => {
  const errors = observe(page), { project } = await fixture(request, info, '长旁白后新增镜头定位验收'); await open(page, project);
  await page.locator('#project-outline').getByRole('button', { name: '添加镜头', exact: true }).click();
  await expect.poll(async () => (await saved(request, project.id)).shots.length).toBe(3);
  const result = await saved(request, project.id); expect(result.shots[0].durationUs).toBe(1_000_000); expect(result.shots[0].sourceInUs).toBeUndefined();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('镜头 3'); await ready(page); await expectClock(page, 4000); await healthy(page, errors);
});

test('locates a duplicated selected group using the real prefix while retaining legacy authored durations', async ({ page, request }, info) => {
  const errors = observe(page), { project } = await fixture(request, info, '长旁白后的多选复制定位验收', true); await open(page, project); await selectB(page);
  await page.getByRole('button', { name: '定位镜头 3：后续镜头 C', exact: true }).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(page.locator('#project-outline .outline-selection')).toContainText('已选 2 个镜头');
  await page.getByRole('region', { name: '项目时间轴', exact: true }).getByRole('button', { name: '复制镜头', exact: true }).click();
  await expect.poll(async () => (await saved(request, project.id)).shots.length).toBe(5); const result = await saved(request, project.id);
  expect(result.shots.map(shot => shot.title)).toEqual(['前置完整旁白 A', '目标镜头 B', '目标镜头 B · 副本', '后续镜头 C', '后续镜头 C · 副本']);
  expect(result.shots[0].durationUs).toBe(1_000_000); expect(result.shots[0].sourceInUs).toBeUndefined();
  await expect(page.getByLabel('镜头标题', { exact: true })).toHaveValue('后续镜头 C · 副本'); await ready(page); await expectClock(page, 6000); await healthy(page, errors);
});

test('rejects a split after a new duration is entered during the preceding save and preserves that input', async ({ page, request }, info) => {
  const errors = observe(page), { project } = await fixture(request, info, '分割等待保存期间新时长保护验收'); await open(page, project); await selectB(page); await seek(page, 105);
  await page.getByLabel('镜头标题', { exact: true }).fill('分割前时长基线'); const gate = await gateFirstSave(page);
  try {
    await page.getByRole('button', { name: '在播放头处分割镜头', exact: true }).click(); await gate.started;
    await page.getByLabel('时长（秒）', { exact: true }).fill('2'); gate.release();
    await expect(page.getByRole('alert').filter({ hasText: /时间|时长|素材|变化|修改/ })).toBeVisible();
    await expect(page.locator('#project-outline .outline-shot')).toHaveCount(2); await expect(page.getByLabel('时长（秒）', { exact: true })).toHaveValue('2'); await expect(page.locator('.project-heading-copy')).toContainText('未保存');
    expect((await saved(request, project.id)).shots[1].durationUs).toBe(1_000_000); expect(gate.writes()).toBe(1);
    const save = page.getByRole('button', { name: '保存修改', exact: true }); await expect(save).toBeEnabled(); await save.click();
    await expect.poll(async () => (await saved(request, project.id)).shots[1].durationUs).toBe(2_000_000); expect((await saved(request, project.id)).shots).toHaveLength(2); expect(gate.writes()).toBe(2); await healthy(page, errors);
  } finally { gate.release(); }
});

test('rejects a split after replacement audio is selected during the preceding save and keeps its new source mapping', async ({ page, request }, info) => {
  const errors = observe(page), { project, asset } = await fixture(request, info, '分割等待保存期间新配音保护验收'); await open(page, project); await selectB(page); await seek(page, 105);
  await page.getByLabel('镜头标题', { exact: true }).fill('分割前媒体基线'); const gate = await gateFirstSave(page);
  try {
    await page.getByRole('button', { name: '在播放头处分割镜头', exact: true }).click(); await gate.started;
    await page.getByLabel('旁白音频', { exact: true }).selectOption(asset.id); gate.release();
    await expect(page.getByRole('alert').filter({ hasText: /时间|素材|配音|变化|修改/ })).toBeVisible();
    await expect(page.locator('#project-outline .outline-shot')).toHaveCount(2); await expect(page.getByLabel('旁白音频', { exact: true })).toHaveValue(asset.id); await expect(page.locator('.project-heading-copy')).toContainText('未保存');
    expect((await saved(request, project.id)).shots[1].audioAssetId).toBeUndefined(); expect(gate.writes()).toBe(1);
    const save = page.getByRole('button', { name: '保存修改', exact: true }); await expect(save).toBeEnabled(); await save.click();
    await expect.poll(async () => (await saved(request, project.id)).shots[1].audioAssetId).toBe(asset.id); const result = await saved(request, project.id);
    expect(result.shots).toHaveLength(2); expect(result.shots[1].audioInUs).toBe(0); expect(gate.writes()).toBe(2); await healthy(page, errors);
  } finally { gate.release(); }
});
