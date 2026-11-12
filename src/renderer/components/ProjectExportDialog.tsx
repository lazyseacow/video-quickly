import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowDownToLine, Download, FileText, Film, FolderOpen, Layers, Square } from 'lucide-react';
import { formatFrameRate, usesVideoAudio, videoProfileSchema, type ProjectDocument } from '@video-quickly/contracts';
import { createSrt } from '@video-quickly/video';
import { rpc } from '../lib/client';
import { nativeDesktop, pathExample, revealFile } from '../lib/desktop';
import { beginGuideAction } from '../lib/guide-actions';
import type { Action, WorkspaceView } from '../lib/types';
import PathPicker from './PathPicker';
import { Button, Dialog, EmptyState, Field, Notice, Status } from './Primitives';
import { ScenePreview } from './ScenePreview';
import SettingsSections from './SettingsSections';
import VideoSettings from './VideoSettings';
import './export-dialog.css';

const EditorProjectExport = lazy(() => import('./EditorProjectExport'));

function downloadText(name: string, content: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ProjectExportDialog({ project, workspace, action, onClose, onBatch, notify }: { project: ProjectDocument; workspace: WorkspaceView; action: Action; onClose: () => void; onBatch: () => void; notify: (message: string, error?: boolean) => void }) {
  const exportGuide = useRef<{ runId?: string; complete: () => void } | undefined>(undefined);
  const closed = useRef(false);
  useEffect(() => { closed.current = false; return () => { closed.current = true; }; }, []);
  function close() { closed.current = true; onClose(); }
  const [exportProfile, setExportProfile] = useState(project.profile);
  const [section, setSection] = useState('video');
  const [editorOpen, setEditorOpen] = useState(false);
  const [outputPath, setOutputPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string>();
  const [exportedPath, setExportedPath] = useState<string>();
  const validProfile = videoProfileSchema.safeParse(exportProfile);
  const lastValidProfile = useRef(project.profile);
  useEffect(() => { if (videoProfileSchema.safeParse(exportProfile).success) lastValidProfile.current = exportProfile; }, [exportProfile]);
  const previewProfile = validProfile.success ? exportProfile : lastValidProfile.current;
  const previewProject = useMemo(() => ({ ...project, profile: previewProfile }), [project, previewProfile]);
  const run = workspace.runs.find(item => item.id === runId);
  const active = busy || Boolean(run && ['queued', 'running', 'waiting_external', 'retry_scheduled'].includes(run.status));
  const stoppableRun = active ? run : undefined;
  const showMp4 = section === 'video';
  useEffect(() => {
    if (run?.status !== 'succeeded') return;
    let mounted = true;
    void rpc<Record<string, unknown>>('node.result', { runId: run.id, nodeId: 'export' }).then(output => {
      if (!mounted || closed.current || !output) return;
      const path = output.videoPath ?? output.path ?? output.outputPath;
      setExportedPath(typeof path === 'string' ? path : '项目输出目录');
      if (typeof path === 'string' && path && exportGuide.current?.runId === run.id) exportGuide.current.complete();
    }).catch(error => { if (mounted) notify(error instanceof Error ? error.message : String(error), true); });
    return () => { mounted = false; };
  }, [run?.id, run?.status, notify]);
  function exportMp4() {
    const attempt: { runId?: string; complete: () => void } = { complete: beginGuideAction('export-completed') };
    exportGuide.current = attempt;
    setBusy(true); setExportedPath(undefined);
    void action<{ runId?: string; id?: string; path?: string; outputPath?: string }>('render.export', { projectId: project.id, profile: exportProfile, ...(outputPath ? { destination: outputPath } : {}) }).then(value => {
      if (closed.current) return;
      setBusy(false);
      if (!value) return;
      const id = value.runId ?? value.id;
      if (id) { attempt.runId = id; setRunId(id); }
      else if (value.path || value.outputPath) { setExportedPath(value.path ?? value.outputPath); attempt.complete(); }
    });
  }
  const preview = project.shots[0] ? <figure className="export-dialog__preview"><div className="export-dialog__frame" style={{ '--export-aspect': previewProfile.width / previewProfile.height } as CSSProperties}><ScenePreview project={previewProject} shot={project.shots[0]} shotIndex={0} assets={workspace.assets} /></div><figcaption>{previewProfile.width} × {previewProfile.height} · {formatFrameRate(previewProfile.frameRate)} fps</figcaption></figure> : <EmptyState icon={<Film size={24} />} title="暂无镜头" description="添加镜头后可预览导出画面。" />;
  return <Dialog title="导出视频" onClose={close} onDismissStart={() => { closed.current = true; }} className="export-dialog settings-dialog">
    <div className="dialog__body"><SettingsSections layout="tabs" label="导出类型" value={section} onValueChange={setSection} sections={[
      { id: 'video', label: 'MP4', content: <>
        <VideoSettings profile={exportProfile} onChange={setExportProfile} mode="delivery" />
        <Field label="输出文件路径" hint="留空时保存到项目的输出目录。">
          {field => <PathPicker field={field} label="输出文件路径" mode="save" value={outputPath} onChange={setOutputPath} extensions={['mp4']} disabled={active} placeholder={pathExample('export')} />}
        </Field>
      </> },
      { id: 'other', label: '其他导出', content: <div className="export-dialog__formats">
        <Button static variant="ghost" disabled={active} onClick={() => setEditorOpen(true)}><Film size={16} aria-hidden="true" />剪映／CapCut 工程</Button>
        <Button static variant="ghost" disabled={active} onClick={onBatch}><Layers size={16} aria-hidden="true" />多比例批量导出</Button>
        <Button static variant="ghost" onClick={() => { downloadText(`${project.title}.srt`, createSrt(project.shots, project)); notify('字幕文件已导出'); }}><FileText size={16} aria-hidden="true" />导出字幕</Button>
        <Button static variant="ghost" onClick={() => { downloadText(`${project.title}-分镜.json`, JSON.stringify(project, null, 2), 'application/json'); notify('分镜文件已导出'); }}><Download size={16} aria-hidden="true" />导出分镜</Button>
      </div> },
    ]} preview={showMp4 ? preview : undefined} previewLabel="首镜头预览" notice={showMp4 ? <>
      {project.shots.every(shot => !shot.audioAssetId && !usesVideoAudio(shot)) && !project.musicClips?.length && <Notice>当前项目没有可用声音，将导出静音视频。</Notice>}
      {run && <div className="export-run"><Status value={run.status} /><p className="tiny-meta">可在工作台的「本次制作」查看导出进度。</p>{run.error && <Notice kind="error">{run.error}</Notice>}</div>}
      {exportedPath && <Notice kind="success">文件已保存：{exportedPath}{nativeDesktop && <Button aria-label="打开文件夹" variant="ghost" onClick={() => void revealFile(exportedPath).catch(error => notify(error instanceof Error ? error.message : String(error), true))}><FolderOpen size={14} />打开文件夹</Button>}</Notice>}
    </> : undefined} /></div>
    {(showMp4 || stoppableRun) && <div className="dialog__footer">
      {stoppableRun ? <Button onClick={() => void action('run.cancel', { runId: stoppableRun.id }, '已请求停止导出')}><Square size={14} aria-hidden="true" />停止导出</Button> : <Button variant="primary" busy={busy} disabled={!validProfile.success || !project.shots.length} onClick={exportMp4}><ArrowDownToLine size={15} aria-hidden="true" />导出 MP4</Button>}
    </div>}
    {editorOpen && <Suspense fallback={null}><EditorProjectExport project={project} onClose={() => setEditorOpen(false)} /></Suspense>}
  </Dialog>;
}
