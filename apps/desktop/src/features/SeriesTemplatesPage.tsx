import { useEffect, useRef, useState } from 'react';
import { Captions, FileText, Image, Pencil, RotateCcw, Trash2, Plus, ChevronDown } from 'lucide-react';
import { recordPageSchema, seriesSettingsSchema, seriesTemplateSchema, type SeriesSettings, type SeriesTemplate } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, IconButton, Notice } from '../components/Primitives';
import SeriesSettingsEditor, { scenePresetLabels, SeriesSettingsPreview } from '../components/SeriesSettingsEditor';
import SettingsSections from '../components/SettingsSections';
import { rpc } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import type { Action, WorkspaceView } from '../lib/types';

const templatesPage = recordPageSchema(seriesTemplateSchema);
const defaultSettings: SeriesSettings = { style: '', captionStyle: null, scenePreset: null };

export default function SeriesTemplatesPage({ workspace, action }: { workspace: WorkspaceView; action: Action }) {
  const [archived, setArchived] = useState(false), [editing, setEditing] = useState<SeriesTemplate | 'new'>(), [readingId, setReadingId] = useState(''), [error, setError] = useState('');
  const library = useRecordPage('seriesTemplate.list', { archived, limit: 20 }, workspace.version, templatesPage);
  const readingGeneration = useRef(0); useEffect(() => { setReadingId(''); return () => { readingGeneration.current++; }; }, []);
  async function edit(templateId: string) {
    const request = ++readingGeneration.current;
    setReadingId(templateId); setError('');
    try { const value = seriesTemplateSchema.parse(await rpc('seriesTemplate.get', { templateId })); if (request === readingGeneration.current) setEditing(value); }
    catch (reason) { if (request === readingGeneration.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (request === readingGeneration.current) setReadingId(''); }
  }
  async function archive(template: SeriesTemplate) {
    const request = ++readingGeneration.current;
    setReadingId(template.id); setError('');
    try { await rpc(archived ? 'seriesTemplate.restore' : 'seriesTemplate.archive', { templateId: template.id, revision: template.revision }); if (request === readingGeneration.current) library.refresh(); }
    catch (reason) { if (request === readingGeneration.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (request === readingGeneration.current) setReadingId(''); }
  }
  return <div className="content-page"><div className="page-heading"><h1>系列模板</h1><Button aria-label="新建系列模板" variant="primary" onClick={() => setEditing('new')}><Plus size={15} />新建</Button></div><div className="page-toolbar"><div className="tabs"><button aria-label="可用模板" type="button" className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>可用</button><button aria-label="已归档模板" type="button" className={archived ? 'active' : ''} onClick={() => setArchived(true)}>已归档</button></div></div>
    {(library.error || error) && <Notice kind="error">{library.error || error}</Notice>}
    <div className="series-template-cards">{library.items.map(template => <article className="series-template-card" key={template.id}><h3>{template.name}</h3><p>{template.description || '尚未填写说明'}</p><span className="tiny-meta">修订 {template.revision} · {new Date(template.updatedAt).toLocaleDateString('zh-CN')}</span><div className="pill-row"><span className="pill">{template.settings.captionStyle ? '自定义字幕' : '默认字幕'}</span><span className="pill">{template.settings.scenePreset ? scenePresetLabels[template.settings.scenePreset.kind] : '无画面预设'}</span></div><div className="series-template-card__actions"><Button aria-label="编辑系列模板" busy={readingId === template.id} disabled={Boolean(readingId && readingId !== template.id)} onClick={() => void edit(template.id)}><Pencil size={13} />编辑</Button><IconButton label={`${archived ? '恢复' : '归档'}系列模板：${template.name}`} disabled={Boolean(readingId)} onClick={() => void archive(template)}>{archived ? <RotateCcw size={15} /> : <Trash2 size={15} />}</IconButton></div></article>)}</div>
    {!library.items.length && !library.busy && !library.error && <EmptyState icon={<Pencil size={24} />} title={archived ? '没有归档的系列模板' : '保存可复用的系列设置'} description="保存风格、字幕和新镜头预设；应用后与模板独立。" />}
    {library.nextCursor !== null && <Button aria-label="加载更多系列模板" busy={library.busy} onClick={() => void library.loadMore()}><ChevronDown size={14} />加载更多</Button>}
    {editing && <SeriesTemplateDialog template={editing === 'new' ? undefined : editing} action={action} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); library.refresh(); }} />}
  </div>;
}

export interface SeriesTemplateDialogProps {
  template?: SeriesTemplate; initialSettings?: SeriesSettings; action: Action; onClose: () => void; onSaved?: (template: SeriesTemplate) => void;
}
export function SeriesTemplateDialog({ template, initialSettings, action, onClose, onSaved }: SeriesTemplateDialogProps) {
  const [name, setName] = useState(template?.name ?? ''), [description, setDescription] = useState(template?.description ?? '');
  const [settings, setSettings] = useState<SeriesSettings>(() => structuredClone(template?.settings ?? initialSettings ?? defaultSettings));
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(''); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const validation = seriesSettingsSchema.safeParse(settings);
  async function save() {
    setBusy(true); setFailure('');
    try {
      const value = await action('seriesTemplate.save', { template: { ...(template ? { id: template.id, revision: template.revision } : {}), name, description, settings } }, '系列模板已保存');
      if (!alive.current) return;
      if (value === null) { setFailure('系列模板尚未保存，当前输入已保留，请核对提示后重试。'); return; }
      const saved = seriesTemplateSchema.parse(value); onSaved?.(saved); onClose();
    } catch (reason) { if (alive.current) setFailure(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  const changeSettings = (value: SeriesSettings) => { setSettings(value); setFailure(''); };
  return <Dialog title={template ? '编辑系列模板' : '保存系列模板'} onClose={onClose} className="series-template-dialog settings-dialog"><div className="dialog__body"><SettingsSections label="系列模板设置" sections={[
    { id: 'basic', label: '基本信息', icon: FileText, content: <><h3>基本信息</h3><Field label="系列模板名称"><input autoFocus value={name} maxLength={120} disabled={busy} onChange={event => setName(event.target.value)} /></Field><Field label="模板说明"><textarea rows={2} value={description} maxLength={10000} disabled={busy} onChange={event => setDescription(event.target.value)} /></Field><SeriesSettingsEditor section="style" value={settings} disabled={busy} onChange={changeSettings} /></> },
    { id: 'caption', label: '字幕样式', icon: Captions, content: <SeriesSettingsEditor section="caption" value={settings} disabled={busy} onChange={changeSettings} /> },
    { id: 'scene', label: '画面预设', icon: Image, content: <SeriesSettingsEditor section="scene" value={settings} disabled={busy} onChange={changeSettings} /> },
  ]} preview={<SeriesSettingsPreview settings={settings} />} notice={<>{!validation.success && <Notice kind="error">{validation.error.issues[0]?.message}</Notice>}{failure && <Notice kind="error">{failure}</Notice>}</>} /></div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button aria-label="保存系列模板" variant="primary" busy={busy} disabled={!name.trim() || !validation.success} onClick={() => void save()}>保存</Button></div></Dialog>;
}
