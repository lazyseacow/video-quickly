import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';

const execute = promisify(execFile);

/** Exercise the installed app's bridge and sidecar, using only its acceptance workspace and loopback suppliers. */
export async function verifyNativeMediaExtensions({ page, rpc, openProject, fixture, artifacts, ffmpegPath, environment, checks }) {
  const directory = join(fixture, 'p4-media'), imagePath = join(directory, 'native-grid.png');
  await mkdir(directory, { recursive: true });
  const originalTitle = await page.getByRole('textbox', { name: '项目名称', exact: true }).inputValue();
  await execute(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=162x92,format=rgba,crop=161:91', '-frames:v', '1', imagePath], { windowsHide: true, env: environment });
  const sourceBytes = await readFile(imagePath), source = await rpc('asset.import', { path: imagePath });
  let project = await rpc('project.create', { title: `原生媒体扩展 ${randomUUID().slice(0, 6)}`, profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } });
  project = await rpc('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'native-media-shot', title: '原生改图镜头', narration: '原生媒体检查', visualPrompt: '木盒画面', durationUs: 1_000_000, assetId: source.id, animation: { transition: 'cut' } }] } });
  const current = async () => (await rpc('project.get', { projectId: project.id })).project;
  const calls = { image: [], text: [] };
  let completed = false;
  const server = createServer((incoming, response) => { void (async () => {
    const chunks = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (incoming.url === '/v1/images/edits') {
      const form = await new Request('http://fixture/images/edits', { method: 'POST', headers: { 'content-type': incoming.headers['content-type'] ?? '' }, body: bytes }).formData();
      const input = form.get('image[]'), mask = form.get('mask');
      assert.ok(input instanceof File); assert.ok(mask instanceof File);
      calls.image.push({ source: Buffer.from(await input.arrayBuffer()), mask: Buffer.from(await mask.arrayBuffer()), prompt: String(form.get('prompt')) });
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ b64_json: sourceBytes.toString('base64') }], usage: { input_tokens: 11, output_tokens: 5 } })); return;
    }
    if (incoming.url === '/v1/chat/completions') {
      const input = JSON.parse(bytes.toString('utf8')); calls.text.push(input);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '原生包建议快照', patch: { prompt: '原生建议：缓慢推近木盒。' } }) } }], usage: { prompt_tokens: 19, completion_tokens: 13 } })); return;
    }
    response.writeHead(404); response.end('fixture endpoint');
  })().catch(error => { response.statusCode = 500; response.end(String(error)); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    await page.getByRole('button', { name: '素材库', exact: true }).click();
    await page.getByRole('button', { name: `网格切图“${source.name}”`, exact: true }).click();
    const grid = page.getByRole('dialog', { name: '网格切图', exact: true });
    await expect(grid.getByRole('combobox', { name: '网格列数', exact: true })).toBeEnabled();
    await grid.getByRole('combobox', { name: '网格列数', exact: true }).selectOption('3'); await grid.getByRole('button', { name: '保存 6 张切图', exact: true }).click();
    await expect(grid.getByAltText(/^切图 \d+$/)).toHaveCount(6);
    const crops = await rpc('image.cutGrid', { assetId: source.id, rows: 2, columns: 3 });
    assert.deepEqual(crops.map(asset => [asset.width, asset.height]), [[53, 45], [54, 45], [54, 45], [53, 46], [54, 46], [54, 46]]);
    assert.ok(crops.every(asset => asset.derivation.sourceSha256 === source.sha256));
    assert.deepEqual((await rpc('image.cutGrid', { assetId: source.id, rows: 2, columns: 3 })).map(asset => asset.id), crops.map(asset => asset.id));
    await page.screenshot({ path: join(artifacts, 'desktop-image-grid.png') }); await grid.getByRole('button', { name: '关闭', exact: true }).click();
    checks.nativeImageGrid = true;
    const mask = await rpc('image.createMask', { assetId: source.id, rectangle: { x: 10, y: 12, width: 40, height: 30 } });
    const decoded = await execute(ffmpegPath, ['-v', 'error', '-i', mask.path, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true, env: environment, encoding: 'buffer', maxBuffer: 2_000_000 });
    assert.equal(decoded.stdout[(12 * 161 + 10) * 4 + 3], 0); assert.equal(decoded.stdout[(11 * 161 + 10) * 4 + 3], 255);
    assert.deepEqual(mask.derivation.rectangle, { x: 10, y: 12, width: 40, height: 30 }); checks.nativeRgbaEditMask = true;
    const imageModel = await rpc('model.save', { model: { name: '原生局部改图夹具', provider: 'openai-compatible', connectionType: 'image', capabilities: ['image'], baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture-image-edit' } });
    await openProject(project.title); await page.getByRole('button', { name: 'AI 微调', exact: true }).click();
    const candidates = page.getByRole('dialog', { name: '镜头候选', exact: true });
    await candidates.getByRole('combobox', { name: '生成内容', exact: true }).selectOption('image'); await candidates.getByRole('combobox', { name: '生成模型', exact: true }).selectOption(imageModel.id);
    const checkbox = candidates.getByRole('checkbox', { name: '局部改图：保留原图并修改选中区域', exact: true }); await expect(checkbox).toBeEnabled(); await checkbox.check();
    for (const [name, value] of [['左侧像素', '10'], ['顶部像素', '12'], ['区域宽度', '40'], ['区域高度', '30']]) await candidates.getByRole('spinbutton', { name, exact: true }).fill(value);
    await candidates.getByRole('textbox', { name: '本次调整要求', exact: true }).fill('原生包中只修改所选木盒区域');
    await candidates.getByRole('button', { name: '生成候选', exact: true }).click();
    const billing = page.getByRole('alertdialog', { name: '生成镜头候选？', exact: true });
    await expect(billing).toContainText('可能产生费用'); assert.equal(calls.image.length, 0);
    await billing.getByRole('button', { name: '确认生成', exact: true }).click();
    await expect(candidates.getByAltText('候选画面')).toBeVisible();
    assert.equal(calls.image.length, 1); assert.deepEqual(calls.image[0].source, sourceBytes); assert.deepEqual(calls.image[0].mask, await readFile(mask.path));
    assert.deepEqual(await current(), project);
    const candidate = (await rpc('shot.candidates', { projectId: project.id, shotId: project.shots[0].id })).items[0]; assert.ok(candidate);
    const frozen = await rpc('run.step.payload', { runId: candidate.runId, nodeId: candidate.nodeId, kind: 'input' }); assert.equal(frozen.value.node.config.imageEdit.sourceAssetId, source.id);
    await candidates.locator('.shot-regeneration__comparison').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(artifacts, 'desktop-image-edit-candidate.png') });
    await candidates.getByRole('button', { name: '应用所选候选', exact: true }).click(); await expect(candidates).toHaveCount(0);
    await expect.poll(async () => (await current()).shots[0].assetId).toBe(candidate.shot.assetId);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await current()).shots[0].assetId).toBe(source.id);
    assert.equal(calls.image.length, 1); checks.nativeMaskedEditCandidate = true;

    const textModel = await rpc('model.save', { model: { name: '原生修改建议夹具', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text'], baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture-text' } });
    project = await current(); const baseline = project.workflow.nodes.find(node => node.kind === 'brief'); assert.ok(baseline);
    const input = { projectId: project.id, revision: project.revision, node: baseline, modelId: textModel.id, instruction: '请简化为缓慢推近木盒', requestId: randomUUID() };
    const startSuggestion = async () => {
      const prepared = await rpc('billing.prepare', { method: 'workflowAssistant.start', params: input });
      return rpc('workflowAssistant.start', { ...input, chargeConfirmationId: prepared.confirmationId });
    };
    const suggestion = await startSuggestion();
    await expect.poll(async () => (await rpc('run.get', { runId: suggestion.run.id })).status).toBe('succeeded');
    const result = await rpc('node.result', { runId: suggestion.run.id, nodeId: suggestion.nodeId }); assert.equal(result.proposal.patch.prompt, '原生建议：缓慢推近木盒。');
    const snapshot = await rpc('run.step.payload', { runId: suggestion.run.id, nodeId: suggestion.nodeId, kind: 'input' }); assert.equal(snapshot.value.project.revision, project.revision); assert.equal(snapshot.value.model.id, textModel.id);
    assert.deepEqual(await current(), project); assert.equal((await rpc('workflowAssistant.start', input)).run.id, suggestion.run.id); assert.equal(calls.text.length, 1); checks.nativeAssistantSnapshot = true;

    await page.getByRole('button', { name: '导出', exact: true }).click(); const output = page.locator('.export-dialog');
    await output.getByRole('tab', { name: '其他导出', exact: true }).click(); await output.getByRole('button', { name: '剪映／CapCut 工程', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '剪映／CapCut 工程导出', exact: true }); await editor.getByRole('textbox', { name: '工程输出目录', exact: true }).fill(directory);
    await editor.getByRole('button', { name: '导出剪辑交接包', exact: true }).click(); await expect(editor.getByText(`剪辑交接包已导出 · 源修订 ${project.revision}`, { exact: true })).toBeVisible();
    const exported = await editor.locator('.editor-project-export__path code').textContent(), manifest = JSON.parse(await readFile(join(exported, 'manifest.json'), 'utf8'));
    assert.equal(manifest.output, 'handoff-only'); assert.equal(manifest.compatibility.desktopImportVerified, false); assert.equal(manifest.files.some(file => file.path === 'draft_info.json'), false);
    assert.ok(manifest.files.some(file => file.path === 'media/picture.mp4')); assert.ok(manifest.files.some(file => file.path === 'media/mix.wav'));
    await page.screenshot({ path: join(artifacts, 'desktop-editor-handoff.png') });
    await editor.getByRole('button', { name: '关闭', exact: true }).click(); await expect(editor).toHaveCount(0);
    await output.getByRole('button', { name: '关闭对话框', exact: true }).click(); await expect(output).toHaveCount(0);
    assert.deepEqual(await current(), project); checks.nativeEditorHandoff = true; completed = true;
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve()));
    if (completed && !page.isClosed()) await openProject(originalTitle);
  }
}
