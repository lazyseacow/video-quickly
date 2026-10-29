import { memo, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronRight, Film, GitBranch, LockKeyhole, Plus } from 'lucide-react';
import type { AssetRecord, ProjectDocument, WorkflowNode } from '@video-quickly/contracts';
import { Button } from './Primitives';
import { ScenePreview } from './ScenePreview';
import TabSurface from './TabSurface';

interface ProjectOutlineProps {
  project: ProjectDocument;
  assets: AssetRecord[];
  selectedShotId?: string;
  selectedNodeId?: string;
  completedNodeIds: string[];
  onSelectShot: (id: string) => Promise<void>;
  onSelectNode: (node: WorkflowNode) => void;
  onAddShot: () => Promise<void>;
  onOpenFlow: () => void;
}

type OutlineTab = 'shots' | 'steps';
const tabs: Array<{ id: OutlineTab; label: string; icon: typeof Film }> = [
  { id: 'shots', label: '镜头列表', icon: Film },
  { id: 'steps', label: '制作步骤', icon: GitBranch },
];

export default memo(function ProjectOutline({ project, assets, selectedShotId, selectedNodeId, completedNodeIds, onSelectShot, onSelectNode, onAddShot, onOpenFlow }: ProjectOutlineProps) {
  const [outlineTab, setOutlineTab] = useState<OutlineTab>('shots');
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const completed = useMemo(() => new Set(completedNodeIds), [completedNodeIds]);

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setOutlineTab(tabs[next].id);
    tabButtons.current[next]?.focus();
  }

  return <>
    <div className="outline-header">
      <TabSurface value={outlineTab} variant="underline" className="outline-tabs" role="tablist" aria-label="项目大纲内容">
        {tabs.map((tab, index) => <button key={tab.id} ref={element => { tabButtons.current[index] = element; }} type="button" id={`${id}-${tab.id}-tab`} role="tab" aria-label={tab.label} aria-selected={outlineTab === tab.id} aria-controls={`${id}-${tab.id}-panel`} tabIndex={outlineTab === tab.id ? 0 : -1} className={outlineTab === tab.id ? 'active' : ''} onKeyDown={event => navigateTabs(event, index)} onClick={() => setOutlineTab(tab.id)}><tab.icon size={14} aria-hidden="true" />{tab.id === 'shots' ? '镜头' : '步骤'}</button>)}
      </TabSurface>
      <span className="count">{outlineTab === 'shots' ? project.shots.length : project.workflow.nodes.length}</span>
    </div>
    {outlineTab === 'shots' ? <div className="shot-list outline-list" id={`${id}-shots-panel`} role="tabpanel" aria-labelledby={`${id}-shots-tab`}>
      {project.shots.length ? project.shots.map((shot, index) => <button type="button" key={shot.id} className={`shot-card outline-shot ${shot.id === selectedShotId ? 'active' : ''}`} aria-pressed={shot.id === selectedShotId} onClick={() => void onSelectShot(shot.id)} title={shot.title}>
        <div className="shot-thumbnail"><ScenePreview project={project} shot={shot} shotIndex={index} assets={assets} thumbnail /><span className="shot-thumb-index">{(index + 1).toString().padStart(2, '0')}</span></div>
        <div className="outline-shot-copy"><div className="shot-card-info"><strong>{shot.title}</strong>{shot.locked ? <LockKeyhole size={12} aria-label="镜头已锁定" /> : shot.assetId || shot.videoAssetId ? <Check size={12} aria-label="已添加画面素材" /> : null}</div><div className="outline-shot-meta">{(shot.durationUs / 1_000_000).toFixed(1)} 秒</div></div>
      </button>) : <div className="outline-empty"><Film size={20} aria-hidden="true" /><p>还没有镜头</p><span>添加镜头，开始安排画面与旁白。</span></div>}
    </div> : <div className="step-list outline-list" id={`${id}-steps-panel`} role="tabpanel" aria-labelledby={`${id}-steps-tab`}>
      {project.workflow.nodes.map((node, index) => <button type="button" key={node.id} className={`step-item ${selectedNodeId === node.id ? 'active' : ''}`} aria-pressed={selectedNodeId === node.id} onClick={() => onSelectNode(node)}><span className={`step-circle ${completed.has(node.id) ? 'done' : selectedNodeId === node.id ? 'current' : ''}`}>{completed.has(node.id) ? <Check size={10} aria-label="已完成" /> : index + 1}</span><span>{node.label}</span><ChevronRight className="step-tail" size={12} aria-hidden="true" /></button>)}
    </div>}
    <div className="outline-footer">{outlineTab === 'shots' ? <Button className="outline-add-shot button-full" variant="ghost" onClick={() => void onAddShot()}><Plus size={15} />添加镜头</Button> : <Button className="button-full" variant="ghost" onClick={onOpenFlow}><GitBranch size={15} />编辑流程图</Button>}</div>
  </>;
});
