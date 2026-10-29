import { useEffect, useRef, useState } from 'react';
import { recordPageSchema, seriesTemplateSchema, type AssetRecord, type ProjectDocument, type SeriesSettings, type SeriesTemplate } from '@video-quickly/contracts';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { applySeriesSettings, DEFAULT_SERIES_APPLY_OPTIONS, type SeriesApplyOptions } from '../lib/series-templates';
import { editContent } from '../lib/project-edits';
import { useRecordPage } from '../lib/use-record-page';
import { rpc } from '../lib/client';
import { Button, Dialog, Field, Notice } from './Primitives';
import { CaptionStylePreview } from './CaptionStyleEditor';
import { SeriesSettingsPreview, SeriesSettingsSummary } from './SeriesSettingsEditor';
import './series-templates.css';

const pageSchema = recordPageSchema(seriesTemplateSchema);
export interface SeriesApplyDialogProps {
  project: ProjectDocument; assets: AssetRecord[]; version?: number; disabled?: boolean; onClose: () => void;
  onApply: (settings: SeriesSettings, options: SeriesApplyOptions, baseline: ProjectDocument) => Promise<boolean>;
}
export default function SeriesApplyDialog({ project, assets, version = 0, disabled = false, onClose, onApply }: SeriesApplyDialogProps) {
  const [baseline] = useState(() => structuredClone(project));
  const library = useRecordPage('seriesTemplate.list', { archived: false, limit: 20 }, version, pageSchema);
  const [templateId, setTemplateId] = useState(''), [snapshot, setSnapshot] = useState<SeriesTemplate>(), [reading, setReading] = useState(false), [refresh, setRefresh] = useState(0);
  const [options, setOptions] = useState<SeriesApplyOptions>(() => ({ ...DEFAULT_SERIES_APPLY_OPTIONS })), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (library.items.length) setTemplateId(current => current || library.items[0].id); }, [library.items]);
  useEffect(() => {
    if (!templateId) return;
    let active = true; setReading(true); setError('');
    void rpc('seriesTemplate.get', { templateId }).then(value => seriesTemplateSchema.parse(value)).then(value => {
      if (!active) return;
      if (value.archived) throw new Error('该系列模板已归档，请恢复后再选择。');
      setSnapshot(structuredClone(value)); if (!value.settings.scenePreset) setOptions(current => ({ ...current, updateExistingSceneLook: false }));
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (active) setReading(false); });
    return () => { active = false; };
  }, [templateId, refresh]);
  const current = snapshot?.id === templateId ? snapshot : undefined;
  const previewProject: ProjectDocument = current ? { ...project, ...applySeriesSettings(editContent(project), current.settings, options, baseline.shots.map(shot => shot.id)) } : project;
  const previewShot = previewProject.shots.find(shot => !shot.locked) ?? previewProject.shots[0];
  const latest = library.items.find(item => item.id === current?.id);
  function change(key: keyof SeriesApplyOptions, checked: boolean) { setOptions(value => ({ ...value, [key]: checked })); setError(''); }
  async function apply() {
    if (!current) return;
    setBusy(true); setError('');
    try {
      // Recheck availability, but apply the exact settings the person reviewed.
      const available = seriesTemplateSchema.parse(await rpc('seriesTemplate.get', { templateId: current.id })); if (available.archived) throw new Error('该系列模板已归档，当前预览已保留。请恢复模板后再应用。');
      if (await onApply(structuredClone(current.settings), { ...options }, baseline)) { if (alive.current) onClose(); } else if (alive.current) setError('系列设置尚未保存，当前选择已保留，可重试。');
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Dialog title="应用系列模板" onClose={onClose} className="series-apply-dialog"><div className="dialog__body"><Field label="选择系列模板"><select value={templateId} disabled={disabled || busy || reading} onChange={event => setTemplateId(event.target.value)}><option value="" disabled>选择可用模板</option>{current && !library.items.some(item => item.id === current.id) && <option value={current.id}>{current.name} · 已载入修订 {current.revision}</option>}{library.items.map(item => <option key={item.id} value={item.id}>{item.name} · 修订 {item.revision}</option>)}</select></Field>
    {library.error && <Notice kind="error">{library.error}<Button onClick={library.refresh}>重新读取系列模板</Button></Notice>}{library.nextCursor !== null && <Button busy={library.busy} onClick={() => void library.loadMore()}><ChevronDown size={13} />加载更多可用模板</Button>}
    {!library.busy && !library.items.length && !current && !library.error && <p className="tiny-meta">还没有可用的系列模板。可先到“系列模板”中保存设置，或将当前项目系列设置保存为模板。</p>}
    {reading && <p role="status" className="tiny-meta">正在读取模板设置…</p>}
    {current && <><p className="series-apply__version">当前预览：{current.name} · 修订 {current.revision}。应用后复制进项目，库中后续修改不会追溯改变项目。{latest && latest.revision !== current.revision && ' 模板库已有新修订，当前仍显示已载入的设置。'}</p><Button variant="ghost" disabled={busy || reading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} />重新读取所选模板</Button><div className="series-template-workspace"><div><SeriesSettingsSummary settings={current.settings} /><fieldset className="series-apply__options" disabled={disabled || busy || reading}><legend>应用范围</legend>
      <label className="field-inline"><input aria-label="应用系列风格文字" type="checkbox" checked={options.style} onChange={event => change('style', event.target.checked)} />系列风格文字</label><label className="field-inline"><input aria-label="应用项目字幕样式" type="checkbox" checked={options.captionStyle} onChange={event => change('captionStyle', event.target.checked)} />项目默认字幕样式</label><label className="field-inline"><input aria-label="应用新镜头画面预设" type="checkbox" checked={options.scenePreset} onChange={event => change('scenePreset', event.target.checked)} />未来新镜头的画面预设</label><label className="field-inline"><input aria-label="清除未锁定镜头字幕覆盖" type="checkbox" checked={options.clearShotCaptionStyles} onChange={event => change('clearShotCaptionStyles', event.target.checked)} />清除未锁定镜头的单独字幕样式，恢复项目默认</label><label className="field-inline"><input aria-label="更新现有模板镜头配色与动效" type="checkbox" checked={options.updateExistingSceneLook} disabled={!current.settings.scenePreset} onChange={event => change('updateExistingSceneLook', event.target.checked)} />只更新现有模板镜头的配色与动效</label><p className="tiny-meta">镜头覆盖与配色同步仅作用于打开窗口时已有的未锁镜头。保留模板类型、标题、旁白、真实数据、资料引用与媒体。</p>
    </fieldset></div><div><p className="series-apply__version">当前项目应用效果示例</p><CaptionStylePreview project={previewProject} shot={previewShot} assets={assets} value={previewShot?.captionStyle ?? null} mode="shot" /><details><summary>查看未来新镜头样式示例</summary><SeriesSettingsPreview settings={current.settings} /></details></div></div></>}
    {error && <Notice kind="error">{error}</Notice>}</div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" busy={busy} disabled={disabled || reading || !current || current.archived || !Object.values(options).some(Boolean)} onClick={() => void apply()}>应用已预览的系列设置</Button></div></Dialog>;
}
