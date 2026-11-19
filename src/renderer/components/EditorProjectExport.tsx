import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { editorExportResultSchema, type EditorExportInput, type ProjectDocument } from '@video-quickly/contracts';
import { Download, FolderOpen } from 'lucide-react';
import { rpc } from '../lib/client';
import { nativeDesktop, revealFile } from '../lib/desktop';
import { Button, Dialog, Field, Notice, Select } from './Primitives';
import PathPicker from './PathPicker';
import './editor-project-export.css';

const dialogResultSchema = editorExportResultSchema.omit({ projectId: true });
type DialogResult = z.infer<typeof dialogResultSchema>;

export default function EditorProjectExport({ project, onClose }: { project: ProjectDocument; onClose(): void }) {
  const [baseline] = useState(() => ({ id: project.id, revision: project.revision, title: project.title, shotCount: project.shots.length }));
  const [target, setTarget] = useState<EditorExportInput['target']>('jianying');
  const [destination, setDestination] = useState('');
  const [template, setTemplate] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [result, setResult] = useState<DialogResult>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function exportProject() {
    setBusy(true); setError(''); setResult(undefined);
    try {
      const request: EditorExportInput = { projectId: baseline.id, revision: baseline.revision, target,
        ...(destination.trim() ? { destinationDirectory: destination.trim() } : {}), ...(template.trim() ? { templatePath: template.trim() } : {}) };
      const exportResult = dialogResultSchema.parse(await rpc('render.editor.export', request));
      if (alive.current) setResult(exportResult);
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Dialog title="剪映／CapCut 工程导出" onClose={onClose} className="editor-project-export">
    <div className="dialog__body editor-project-export__body">
      <p className="editor-project-export__intro">{baseline.title} · 修订 {baseline.revision}</p>
      <fieldset disabled={busy} className="editor-project-export__fields"><legend>剪辑工程设置</legend>
        <Field label="剪辑软件"><Select value={target} onChange={event => { setTarget(event.target.value === 'capcut' ? 'capcut' : 'jianying'); setTemplate(''); setResult(undefined); }}><option value="jianying">剪映</option><option value="capcut">CapCut</option></Select></Field>
        <Field label="空草稿模板（可选）" hint="实验性草稿需使用目标软件生成的未加密空模板（draft_info.json 或 draft_content.json）。留空导出交接包。">
          {field => <PathPicker field={field} label="空草稿模板（可选）" value={template} onChange={value => { setTemplate(value); setResult(undefined); }} extensions={['json']} placeholder="留空导出剪辑交接包" />}
        </Field>
        <Field label="工程输出目录" hint="留空使用项目导出目录；每次创建独立文件夹。请选择软件草稿库以外的位置。">
          {field => <PathPicker field={field} label="工程输出目录" mode="directory" value={destination} onChange={setDestination} placeholder="选择或填写文件夹路径" />}
        </Field>
      </fieldset>
      <details className="editor-project-export__scope"><summary>导出内容与编辑范围</summary><ul>
        <li>画面效果、动画、裁切与转场已合成为视频，按分镜保留剪切点。</li>
        <li>声音保留为独立混音轨，旁白、原声与音乐已合并。</li>
        <li>已开启的字幕保留文字和时间，目标软件中的字体与排版需核对。</li>
        <li>草稿的实际导入尚未验证。软件版本不同可能需要重新链接素材。</li>
      </ul></details>
      {busy && <Notice>正在合成画面与声音。关闭窗口后继续导出。</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {result && <section className="editor-project-export__result" aria-label="剪辑工程导出结果"><Notice kind="success">{result.format === 'draft' ? '实验性草稿已导出' : '剪辑交接包已导出'} · 源修订 {result.projectRevision}</Notice>
        {result.editorVersion && <p className="tiny-meta">模板软件版本：{result.editorVersion}</p>}
        <p>{result.format === 'draft' ? '请在目标软件中导入草稿，核对声画和字幕。' : '交接包包含画面、混音、字幕和 compile.json 时间线。'}</p>
        <div className="editor-project-export__path"><span>输出位置</span><code>{result.directory}</code></div>
        {nativeDesktop && <Button variant="ghost" onClick={() => void revealFile(result.manifestPath).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))}><FolderOpen size={14} />打开导出文件夹</Button>}
        <details><summary>导出说明</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>
      </section>}
    </div>
    <div className="dialog__footer"><Button onClick={onClose}>关闭</Button><Button variant="primary" busy={busy} disabled={!baseline.shotCount} onClick={() => void exportProject()}><Download size={14} />{template.trim() ? '导出实验性草稿' : '导出剪辑交接包'}</Button></div>
  </Dialog>;
}
