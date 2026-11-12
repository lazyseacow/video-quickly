import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { captionsEnabled, clipSourceAssetIds, firstFrameAtUs, projectSchema, timeAtFrame, type AssetRecord, type EditorExportInput, type EditorExportResult, type ProjectDocument } from '@video-quickly/contracts';
import { buildTimeline, createSrt, createSubtitleCues } from '@video-quickly/video';
import { prepareAudioMix, resolveAudioProject } from '@video-quickly/video/audio-mix';
import { probeMedia, renderProject, runMedia } from '@video-quickly/video/node';
import { editorDraftLicense } from './editor-draft-license.js';
import { hashFileSha256 } from './file-hash.js';

export interface EditorExportOptions extends Pick<EditorExportInput, 'target' | 'destinationDirectory' | 'templatePath'> {
  project: ProjectDocument; assets: AssetRecord[]; dataDirectory: string;
  ffmpegPath?: string; ffprobePath?: string; signal?: AbortSignal;
  onProgress?: (value: number) => void;
}
type DraftObject = Record<string, unknown>;
type DraftMaterial = Record<string, unknown>;
type Template = { markers: DraftObject; sha256: string; version: string };

function object(value: unknown): value is DraftObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** The template supplies local version markers only; no media, identities or nested timelines are copied. */
async function loadTemplate(path: string, target: EditorExportOptions['target']): Promise<Template> {
  const info = await lstat(resolve(path));
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 2_000_000) throw new Error('请选择不超过 2 MB 的本地明文空草稿 JSON 文件。');
  const bytes = await readFile(path);
  if (bytes.length !== info.size || bytes.length > 2_000_000) throw new Error('空草稿模板在读取时已改变，请重新选择。');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('草稿模板不是明文 JSON；请从本机剪辑软件提供可读取的空草稿，当前不支持加密模板。'); }
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.depth > 24) throw new Error('草稿模板结构过深。');
    if (entry.value && typeof entry.value === 'object') for (const [key, child] of Object.entries(entry.value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('草稿模板包含无效字段。');
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
  if (!object(value) || !Array.isArray(value.tracks) || value.tracks.some(track => !object(track) || !Array.isArray(track.segments) || track.segments.length > 0) || !object(value.materials)) throw new Error('请选择不含片段的空草稿模板。');
  if (Object.values(value.materials).some(items => !Array.isArray(items) || items.length > 0)) throw new Error('空草稿模板不能包含已有素材。');
  if (!object(value.platform) || value.platform.app_source !== (target === 'capcut' ? 'cc' : 'lv') || typeof value.platform.app_version !== 'string' || !value.platform.app_version.trim()) throw new Error('空草稿的平台与导出目标不一致，或缺少软件版本信息。');
  const markers: DraftObject = {};
  for (const key of ['platform', 'last_modified_platform', 'version', 'new_version', 'config', 'mutable_config', 'color_space']) if (value[key] !== undefined) markers[key] = value[key];
  return { markers, version: value.platform.app_version, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Never publish into an editor's live draft store, even when selected as the output parent. */
function assertOutputParent(path: string) {
  if (/(^|[\\/])com\.lveditor\.draft(?:[\\/]|$)|(?:CapCut|JianyingPro|剪映专业版)[\\/]User Data[\\/]Projects(?:[\\/]|$)/i.test(path)) throw new Error('请选择剪辑软件草稿库以外的输出目录，导出后再手动导入。');
}

function makeTrack(type: 'video' | 'audio' | 'text', name: string) { return { id: randomUUID(), type, name, attribute: 0, flag: 0, is_default_name: false, segments: [] as DraftObject[] }; }

function companions(kind: 'video' | 'audio' | 'text', materials: Record<string, DraftMaterial[]>): string[] {
  const entries: Array<[string, DraftMaterial]> = [
    ['speeds', { type: 'speed', speed: 1, mode: 0, curve_speed: null }],
    ['placeholder_infos', { type: 'placeholder_info', error_path: '', error_text: '', meta_type: 'none', res_path: '', res_text: '' }],
    ['sound_channel_mappings', { type: 'none', audio_channel_mapping: 0, is_config_open: false }],
    ['vocal_separations', { type: 'vocal_separation', choice: 0, enter_from: '', final_algorithm: '', production_path: '', removed_sounds: [], time_range: null }],
  ];
  if (kind === 'video') entries.push(['canvases', { type: 'canvas_color', album_image: '', blur: 0, color: '', image: '', image_id: '', image_name: '', source_platform: 0, team_id: '' }]);
  return entries.map(([key, entry]) => { const id = randomUUID(); (materials[key] ??= []).push({ ...entry, id }); return id; });
}

function segment(kind: 'video' | 'audio' | 'text', materialId: string, trackId: string, start: number, duration: number, sourceStart: number, materials: Record<string, DraftMaterial[]>) {
  return {
    id: randomUUID(), material_id: materialId, raw_segment_id: trackId,
    source_timerange: { start: sourceStart, duration }, target_timerange: { start, duration },
    speed: 1, volume: kind === 'video' ? 0 : 1, visible: true, reverse: false,
    clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: kind === 'text' ? -.8 : 0 }, flip: { horizontal: false, vertical: false } },
    render_index: kind === 'text' ? 15000 : kind === 'video' ? 14000 : 11000,
    track_render_index: 0, track_attribute: 0, extra_material_refs: companions(kind, materials), common_keyframes: [], keyframe_refs: [],
  };
}

function metaMaterial(path: string, kind: 'video' | 'music', duration: number, width: number, height: number) {
  return { id: randomUUID(), file_Path: path, extra_info: basename(path), metetype: kind, duration, width, height,
    ai_group_type: '', create_time: -1, enter_from: 0, import_time: -1, import_time_ms: -1, item_source: 1,
    material_color_tag: '', md5: '', roughcut_time_range: { duration: -1, start: -1 }, sub_time_range: { duration: -1, start: -1 }, type: 0 };
}

function draftDocuments(project: ProjectDocument, template: Template, id: string, directory: string, cuts: EditorCut[], duration: number, cues: ReturnType<typeof createSubtitleCues>) {
  const picture = join(directory, 'media', 'picture.mp4'), audio = join(directory, 'media', 'mix.wav');
  const registered = [metaMaterial(picture, 'video', duration, project.profile.width, project.profile.height), metaMaterial(audio, 'music', duration, 0, 0)];
  const materials: Record<string, DraftMaterial[]> = { videos: [], audios: [], texts: [], stickers: [], transitions: [], video_effects: [], masks: [], chromas: [], audio_fades: [], audio_effects: [] };
  const videoId = randomUUID(), audioId = randomUUID();
  materials.videos.push({ id: videoId, type: 'video', path: picture, material_name: 'picture.mp4', duration, width: project.profile.width, height: project.profile.height,
    has_audio: false, check_flag: 7, category_id: '', category_name: 'local', local_material_id: registered[0].id, local_id: '', material_url: '', media_path: '', source_platform: 0,
    crop: { lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1, upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0 } });
  materials.audios.push({ id: audioId, type: 'extract_music', path: audio, name: 'mix.wav', duration, check_flag: 1, category_id: '', category_name: 'local', music_id: '', local_material_id: registered[1].id, wave_points: [] });
  const videoTrack = makeTrack('video', '分镜画面（效果已合成）'), audioTrack = makeTrack('audio', '声音（已混音）'), textTrack = makeTrack('text', '字幕');
  videoTrack.segments = cuts.map(cut => segment('video', videoId, videoTrack.id, cut.startUs, cut.durationUs, cut.startUs, materials));
  audioTrack.segments = cuts.map(cut => segment('audio', audioId, audioTrack.id, cut.startUs, cut.durationUs, cut.startUs, materials));
  for (const cue of cues) {
    const text = cue.lines.join('\n'), textId = randomUUID(), fontSize = 15;
    materials.texts.push({ id: textId, type: 'text', alignment: 1, font_size: fontSize, text_color: '#FFFFFF', typesetting: 0, letter_spacing: 0, line_spacing: .02, line_feed: 1, line_max_width: .82, force_apply_line_max_width: false, check_flag: 7, fixed_width: -1, fixed_height: -1,
      content: JSON.stringify({ text, styles: [{ range: [0, text.length], size: fontSize, bold: false, italic: false, underline: false, fill: { alpha: 1, content: { render_type: 'solid', solid: { alpha: 1, color: [1, 1, 1] } } } }] }) });
    textTrack.segments.push(segment('text', textId, textTrack.id, cue.startUs, cue.endUs - cue.startUs, 0, materials));
  }
  const document = { ...template.markers, id, name: project.title, duration, fps: project.profile.frameRate.numerator / project.profile.frameRate.denominator,
    canvas_config: { width: project.profile.width, height: project.profile.height, ratio: 'original' }, tracks: [videoTrack, audioTrack, ...(cues.length ? [textTrack] : [])], materials };
  const meta = { draft_id: id, draft_name: project.title, draft_fold_path: directory, draft_json_file: join(directory, 'draft_info.json'), draft_root_path: dirname(directory), draft_cover: 'cover.png', tm_duration: duration,
    tm_draft_create: Date.now() * 1000, tm_draft_modified: Date.now() * 1000, tm_draft_removed: 0, draft_materials: [{ type: 0, value: registered }] };
  return { document, meta };
}

interface EditorCut { shotId: string; title: string; authoredStartUs: number; authoredDurationUs: number; startUs: number; durationUs: number; firstFrame: number; endFrame: number }

/** Fully local, immutable export. No editor installation, registration or provider calls are performed. */
export async function exportEditorProject(options: EditorExportOptions): Promise<EditorExportResult> {
  const authored = projectSchema.parse(options.project);
  if (!authored.shots.length) throw new Error('请先添加分镜再导出剪辑工程。');
  const template = options.templatePath ? await loadTemplate(options.templatePath, options.target) : undefined;
  const ffmpeg = options.ffmpegPath ?? process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
  const ffprobe = options.ffprobePath ?? process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  for (const shot of authored.shots) {
    if (shot.sceneTemplate) continue;
    const id = shot.videoAssetId ?? shot.assetId;
    if (!id) continue;
    const asset = options.assets.find(asset => asset.id === id), kind = shot.videoAssetId ? 'video' : 'image';
    if (!asset?.active || asset.kind !== kind || asset.projectId !== undefined && asset.projectId !== authored.id) throw new Error(`镜头「${shot.title}」的画面素材缺失或不可用，请先修复素材引用。`);
  }
  const project = await resolveAudioProject({ project: authored, assets: options.assets, ffmpegPath: ffmpeg, ffprobePath: ffprobe, signal: options.signal });
  const requestedParent = resolve(options.destinationDirectory ?? join(options.dataDirectory, 'projects', project.id, 'exports'));
  assertOutputParent(requestedParent); await mkdir(requestedParent, { recursive: true });
  const parent = await realpath(requestedParent); assertOutputParent(parent);
  const id = randomUUID(), finalDirectory = join(parent, `vq-edit-${id}`), staging = join(parent, `.vq-edit-${id}.partial`);
  await mkdir(staging); const owned = await lstat(staging);
  try {
    options.signal?.throwIfAborted();
    const renderDirectory = join(staging, '.render');
    const rate = project.profile.frameRate;
    const cuts = buildTimeline(project.shots).map((clip, index): EditorCut => {
      const firstFrame = firstFrameAtUs(clip.startUs, rate), endFrame = firstFrameAtUs(clip.endUs, rate), startUs = timeAtFrame(firstFrame, rate);
      return { shotId: clip.shotId, title: project.shots[index].title, authoredStartUs: clip.startUs, authoredDurationUs: clip.durationUs, startUs, durationUs: timeAtFrame(endFrame, rate) - startUs, firstFrame, endFrame };
    });
    const durationUs = timeAtFrame(cuts.at(-1)!.endFrame, rate);
    const mix = await prepareAudioMix({ project, assets: options.assets, outputDirectory: join(renderDirectory, 'audio'), ffmpegPath: ffmpeg, ffprobePath: ffprobe, signal: options.signal });
    const render = await renderProject({ project: { ...project, workflow: { ...project.workflow, production: { ...project.workflow.production, subtitleMode: 'off' } } }, assets: options.assets, outputDirectory: renderDirectory, preparedAudioMix: mix, ffmpegPath: ffmpeg, ffprobePath: ffprobe, signal: options.signal, onProgress: value => options.onProgress?.(value * .8) });
    const media = join(staging, 'media'); await mkdir(media);
    // Preserve the renderer's frame ticks; automatic MP4 timescales can round a complete stream's duration during remux.
    await runMedia(ffmpeg, ['-nostdin', '-v', 'error', '-i', render.videoPath, '-map', '0:v:0', '-an', '-c:v', 'copy', '-video_track_timescale', String(rate.numerator), join(media, 'picture.mp4')], { signal: options.signal });
    const samples = Math.round(durationUs * 48000 / 1_000_000);
    await runMedia(ffmpeg, ['-nostdin', '-v', 'error', '-i', mix.path, '-vn', '-af', `apad=whole_len=${samples},atrim=end_sample=${samples}`, '-c:a', 'pcm_s16le', '-ar', '48000', join(media, 'mix.wav')], { signal: options.signal });
    await rename(render.coverPath, join(staging, 'cover.png'));
    const video = await probeMedia(join(media, 'picture.mp4'), ffprobe, options.signal), audio = await probeMedia(join(media, 'mix.wav'), ffprobe, options.signal);
    if (video.audio || !audio.audio || Math.abs((video.videoDuration ?? video.duration) * 1_000_000 - durationUs) > 2 || Math.abs(audio.duration * 1_000_000 - durationUs) > 1_000) throw new Error('剪辑交接素材的时长或声画分离校验失败。');
    const cues = captionsEnabled(project) ? createSubtitleCues(project.shots, text => [[text]], project) : [];
    const warnings = [...render.warnings, '画面中的裁切、动画、转场和场景模板已合成为视频；工程按分镜保留剪切点。', '声音已混成一条轨道，旁白、原声和音乐不能在目标软件中逐源调整。', '字幕保留文字和时间；导入后的字体、背景和排版需要在目标软件中核对。', '剪映／CapCut 实际导入尚未验证；不同软件版本可能拒绝草稿或要求重新链接素材。'];
    const spec = { name: `vq-edit-${id}`, width: project.profile.width, height: project.profile.height, fps: rate.numerator / rate.denominator,
      tracks: [
        { type: 'video', name: '分镜画面（效果已合成）', items: cuts.map(cut => ({ path: 'media/picture.mp4', start: cut.startUs / 1_000_000, sourceStart: cut.startUs / 1_000_000, duration: cut.durationUs / 1_000_000, volume: 0 })) },
        { type: 'audio', name: '声音（已混音）', items: [{ path: 'media/mix.wav', start: 0, duration: durationUs / 1_000_000, volume: 1 }] },
        ...(cues.length ? [{ type: 'text', name: '字幕', items: cues.map(cue => ({ text: cue.lines.join('\n'), start: cue.startUs / 1_000_000, duration: (cue.endUs - cue.startUs) / 1_000_000, fontSize: 15, y: -.8 })) }] : []),
      ] };
    await writeFile(join(staging, 'compile.json'), JSON.stringify(spec, null, 2), { flag: 'wx' });
    await writeFile(join(staging, 'subtitles.srt'), captionsEnabled(project) ? createSrt(project.shots, project) : '', { flag: 'wx' });
    if (template) {
      const draft = draftDocuments(project, template, id, finalDirectory, cuts, durationUs, cues);
      await writeFile(join(staging, 'draft_info.json'), JSON.stringify(draft.document), { flag: 'wx' });
      await writeFile(join(staging, 'draft_content.json'), JSON.stringify(draft.document), { flag: 'wx' });
      await writeFile(join(staging, 'draft_meta_info.json'), JSON.stringify(draft.meta), { flag: 'wx' });
    }
    const files = await Promise.all(['media/picture.mp4', 'media/mix.wav', 'subtitles.srt', 'compile.json', 'cover.png', ...(template ? ['draft_info.json', 'draft_content.json', 'draft_meta_info.json'] : [])].map(async path => ({ path, size: (await stat(join(staging, path))).size, sha256: await hashFileSha256(join(staging, path), options.signal) })));
    const sourceIds = new Set([...project.shots.flatMap(shot => [shot.assetId, shot.videoAssetId, shot.audioAssetId]), ...(project.musicClips ?? []).map(clip => clip.assetId), ...(project.clipEditSources ?? []).flatMap(clipSourceAssetIds)]);
    const sourceAssets = options.assets.filter(asset => sourceIds.has(asset.id)).map(asset => ({ assetId: asset.id, sha256: asset.sha256, kind: asset.kind }));
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({ format: 'video-quickly-editor-handoff', version: 1, id, projectId: project.id, projectRevision: project.revision, title: project.title, target: options.target,
      output: template ? 'experimental-draft' : 'handoff-only', frameRate: rate, durationUs, cuts, files, sourceAssets, createdAt: new Date().toISOString(),
      template: template ? { sha256: template.sha256, editorVersion: template.version } : undefined, compatibility: { desktopImportVerified: false, windowsVerified: false, macosVerified: false },
      schemaReference: { repository: 'https://github.com/renezander030/capcut-cli', commit: '5d4220a8e1845642cebb89d188e63713c1f0ccfc', license: 'MIT' }, warnings }, null, 2), { flag: 'wx' });
    await writeFile(join(staging, 'THIRD_PARTY_NOTICES.txt'), editorDraftLicense, { flag: 'wx' });
    await writeFile(join(staging, 'README.txt'), `Video Quickly 剪辑${template ? '草稿（实验性）' : '交接包'}\n目标：${options.target === 'jianying' ? '剪映' : 'CapCut'}\n源项目修订：${project.revision}\n${template ? `模板软件版本：${template.version}\n草稿为 draft_info.json / draft_content.json；未写入或注册到软件草稿库。` : '当前没有草稿文件。要生成实验性草稿，请在 Video Quickly 导出窗口选择本机软件创建的明文空草稿 JSON。'}\n\n${warnings.join('\n')}\n\n素材位置：media/picture.mp4 为无声画面，media/mix.wav 为混音。subtitles.srt 为独立字幕；manifest.json 保存帧网格、剪切点和校验值。\n\n搬移或跨平台使用：compile.json 中的素材路径相对于本目录；草稿使用导出时的绝对路径，搬移后请在剪辑软件中重新链接 media 文件。不要覆盖已有项目。\n\n可选开源工具流程（需自行安装 capcut-cli 0.32.0，MIT）：\ncapcut compile "<本目录>/compile.json" --out "<新的输出目录>" --template "<本机软件的空白草稿文件夹>"\n请先查阅对应版本的 capcut compile --help；现代软件需要本机草稿版本标记。\n来源与兼容证据：https://github.com/renezander030/capcut-cli/blob/5d4220a8e1845642cebb89d188e63713c1f0ccfc/docs/version-support.md\n`, { flag: 'wx' });
    // This directory was created by this invocation, and is always a direct child of its owned staging directory.
    if (resolve(renderDirectory) !== join(resolve(staging), '.render')) throw new Error('导出临时目录校验失败。');
    await rm(renderDirectory, { recursive: true, force: true });
    options.signal?.throwIfAborted(); await rename(staging, finalDirectory); options.onProgress?.(1);
    return { id, projectId: project.id, projectRevision: project.revision, target: options.target, format: template ? 'draft' : 'handoff', directory: finalDirectory, manifestPath: join(finalDirectory, 'manifest.json'), specPath: join(finalDirectory, 'compile.json'), ...(template ? { draftPath: join(finalDirectory, 'draft_info.json'), editorVersion: template.version } : {}), warnings };
  } catch (error) {
    const current = await lstat(staging).catch(() => undefined);
    if (relative(parent, staging) === `.vq-edit-${id}.partial` && current?.isDirectory() && !current.isSymbolicLink() && current.ino === owned.ino && current.dev === owned.dev) await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    throw error;
  }
}
