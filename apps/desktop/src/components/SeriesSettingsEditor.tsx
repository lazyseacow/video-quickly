import { createHistoryWorkflow, createSceneTemplate, DEFAULT_VIDEO_PROFILE, projectSchema, shotSchema, type ScenePreset, type SeriesSettings } from '@video-quickly/contracts';
import { Field, Select } from './Primitives';
import CaptionStyleEditor, { CaptionStylePreview } from './CaptionStyleEditor';
import './series-templates.css';

export const scenePresetLabels = { process: '流程讲解', comparison: '双栏对照', 'bar-chart': '条形数据图' };
export default function SeriesSettingsEditor({ value, disabled = false, section, onChange }: { value: SeriesSettings; disabled?: boolean; section?: 'style' | 'caption' | 'scene'; onChange: (value: SeriesSettings) => void }) {
  function changePreset(patch: Partial<ScenePreset>) { if (value.scenePreset) onChange({ ...value, scenePreset: { ...value.scenePreset, ...patch } }); }
  return <div className="series-settings-editor">{(!section || section === 'style') && <Field label="系列风格文字" hint="用于后续生成，已有画面保持原样。"><textarea rows={4} maxLength={30000} value={value.style} disabled={disabled} onChange={event => onChange({ ...value, style: event.target.value })} /></Field>}
    {(!section || section === 'caption') && <fieldset className="series-settings-editor__group"><legend>默认字幕样式</legend><CaptionStyleEditor value={value.captionStyle} disabled={disabled} inheritLabel="使用默认字幕表现" onChange={captionStyle => onChange({ ...value, captionStyle })} /></fieldset>}
    {(!section || section === 'scene') && <fieldset className="series-settings-editor__group"><legend>新镜头画面预设</legend><Field label="新镜头模板"><Select value={value.scenePreset?.kind ?? ''} disabled={disabled} onChange={event => onChange({ ...value, scenePreset: event.target.value ? { kind: event.target.value as ScenePreset['kind'], palette: value.scenePreset?.palette ?? 'sage', motion: value.scenePreset?.motion ?? 'reveal' } : null })}><option value="">不设置画面模板</option>{Object.entries(scenePresetLabels).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}</Select></Field>{value.scenePreset && <div className="field-row"><Field label="预设配色"><Select value={value.scenePreset.palette} disabled={disabled} onChange={event => changePreset({ palette: event.target.value as ScenePreset['palette'] })}><option value="sage">鼠尾草绿</option><option value="blue">蓝色</option><option value="amber">琥珀色</option></Select></Field><Field label="预设动效"><Select value={value.scenePreset.motion} disabled={disabled} onChange={event => changePreset({ motion: event.target.value as ScenePreset['motion'] })}><option value="reveal">逐项呈现</option><option value="none">静态展示</option></Select></Field></div>}<p className="tiny-meta">仅保存类型、配色和动效，不含标题、旁白或数据。</p></fieldset>}
  </div>;
}

export function SeriesSettingsPreview({ settings }: { settings: SeriesSettings }) {
  const sceneTemplate = settings.scenePreset ? { ...createSceneTemplate(settings.scenePreset.kind), palette: settings.scenePreset.palette, motion: settings.scenePreset.motion } : undefined;
  const shot = shotSchema.parse({ id: 'series-preview-shot', title: '系列样式示例', narration: '', visualPrompt: '', durationUs: 4_000_000, sceneTemplate });
  const project = { ...projectSchema.parse({ id: 'series-preview', title: '系列样式示例', brief: '', revision: 1, profile: { ...DEFAULT_VIDEO_PROFILE, width: 640, height: 360, previewScale: 1 }, shots: [shot], workflow: createHistoryWorkflow(), createdAt: '', updatedAt: '' }), captionStyle: settings.captionStyle };
  return <div className="series-settings-preview"><CaptionStylePreview project={project} shot={shot} assets={[]} value={settings.captionStyle} /><p className="tiny-meta">示例数据仅用于预览字幕与画面；风格文字用于后续生成。</p></div>;
}

export function SeriesSettingsSummary({ settings }: { settings: SeriesSettings }) {
  return <dl className="series-settings-summary"><dt>系列风格</dt><dd>{settings.style || '（空白风格文字）'}</dd><dt>字幕样式</dt><dd>{settings.captionStyle ? `${settings.captionStyle.fontId === 'serif' ? '衬线体' : '无衬线体'} · ${Number((settings.captionStyle.fontSizeRatio * 100).toFixed(2))}% 短边 · ${settings.captionStyle.position === 'top' ? '上部' : '下部'} · ${settings.captionStyle.maxLines} 行` : '默认表现（清除项目自定义字幕样式）'}</dd><dt>新镜头预设</dt><dd>{settings.scenePreset ? `${scenePresetLabels[settings.scenePreset.kind]} · ${{ sage: '鼠尾草绿', blue: '蓝色', amber: '琥珀色' }[settings.scenePreset.palette]} · ${settings.scenePreset.motion === 'none' ? '静态' : '逐项呈现'}` : '无预设（清除项目的新镜头模板预设）'}</dd></dl>;
}
