import { pathExample, shortcutLabel } from '../lib/desktop';
import SubflowInputBindings from '../components/SubflowInputBindings';
import { CreativeEntityPicker } from '../components/CreativeContextEditor';
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Undo2, Redo2, PanelLeft, PanelRight, PanelRightClose, ScanLine, Settings2, FileText, Film, Image, Layers, LockKeyhole, Save, UnlockKeyhole, WandSparkles, ArrowDownToLine, Upload, Square } from 'lucide-react';
import { applyShotCandidate, captionTrackSchema, createSceneTemplate, DEFAULT_AUDIO_PROCESSING, runStepPayloadSchema, shotSchema, silenceDetectionSchema, timeAtFrame, usesManualPlanning, usesVideoAudio, type AssetRecord, type CaptionStyle, type CaptionTrack, type JsonValue, type MusicClip, type ProjectDocument, type ProjectReadiness, type ReadinessIssue, type ResolvedWorkflowStage, type Shot, type ShotCandidate, type ShotCandidateField, type ShotCandidateKind, type WorkflowNode } from '@video-quickly/contracts';
import { buildTimeline, createTransitionTimeline } from '@video-quickly/video';
import { canSplitShot, preserveSceneIndices, splitShotInContext, trimShotInContext } from '@video-quickly/video/editing';
import ClipTiming from '../components/ClipTiming';
import { applyKeyframeEdit } from '../lib/keyframe-edits';
import { sourceDurationsKey, useSourceDuration } from '../lib/source-duration';
import { Button, Dialog, EmptyState, Field, IconButton, Notice, Select } from '../components/Primitives';
import PlaybackPreview from '../components/PlaybackPreview';
import Timeline from '../components/Timeline';
import { PlaybackClock } from '../lib/playback';
import ProjectOutline from '../components/ProjectOutline';
import ProjectMoreActions from '../components/ProjectMoreActions';
import WorkbenchProduction, { type StageViewOptions } from './WorkbenchProduction';
import WorkbenchGuide from './WorkbenchGuide';
import { matchingStepModels, stepGuidance, stepModelLabel, stepModelPlaceholder } from '../lib/workflow-guidance';
import { PanelResizeHandle } from '../components/PanelResizeHandle';
import ProjectExportDialog from '../components/ProjectExportDialog';
import type { ProjectSettingsAction } from '../components/ProjectSettingsPanel';
import { useContentMotion } from '../lib/motion';
import ToolBindings from '../components/ToolBindings';
import SkillPicker from '../components/SkillPicker';
import PathPicker from '../components/PathPicker';
import { rpc } from '../lib/client';
import type { Action, StepOutputSelection, WorkspaceView } from '../lib/types';
import { useProjectEdits } from '../lib/use-project-edits';
import { useStageConfigurationDraft } from '../lib/use-stage-configuration-draft';
import { applyProductionProjectDraft, applyStageConfigurationDraft } from '../lib/stage-configuration-draft';
import type { ProductionConfiguration } from '../components/ProductionSettingsDialog';
import { resolveWorkbenchStages } from '../lib/workbench-stages';
import { editContent, sameContent, type EditContent } from '../lib/project-edits';
import { applyPlanningEdit, planningLabels, type PlanningChange, type PlanningEditOptions, type PlanningProject, type PlanningSection } from '../lib/planning-edits';
import DraftConflictDialog from '../components/DraftConflictDialog';
import CaptionEditor from '../components/CaptionEditor';
import MusicEditor from '../components/MusicEditor';
import { CharacterPicker } from '../components/CharacterPicker';
import SceneTemplateEditor from '../components/SceneTemplateEditor';
import BatchExportDialog from '../components/BatchExportDialog';
import { applyCaptionStyleEdit, type CaptionStyleTarget } from '../lib/style-edits';
import { normalizeSelection, selectAllShots, selectShot as updateShotSelection, type SelectionModifiers, type ShotSelection } from '../lib/shot-selection';
import { applyBulkShotEdit, bulkDuplicateShots, bulkMoveShots, bulkRemoveShots, bulkReorderShots } from '../lib/bulk-shot-edits';
import type { BulkShotRequest } from '../components/BulkShotDialog';
import { prepareAudioMixPreview, readAudioLevels, usePreparedProjectMix } from '../lib/audio-mix';
import { measuredAudioShots, rememberAudioDurations } from '../lib/audio-timing';
import { replaceShotMedia, sourceCaptionTrack, type ClipRange } from '@video-quickly/video/clip-edits';
import { applyTranscriptEdit, assertTranscriptBaseline, type TranscriptEditAction, type TranscriptSilenceOptions, type TranscriptSubmission } from '../lib/transcript-edits';
import { beginGuideAction } from '../lib/guide-actions';
import { useConfirmation } from '../components/ConfirmationDialog';
import { useWorkbenchProduction } from './use-workbench-production';

const KeyframeEditor = lazy(() => import('../components/KeyframeEditor'));
const TranscriptEditingDialog = lazy(() => import('../components/TranscriptEditingDialog'));
const CaptionStyleDialog = lazy(() => import('../components/CaptionStyleEditor').then(module => ({ default: module.CaptionStyleDialog })));
const BulkShotDialog = lazy(() => import('../components/BulkShotDialog'));
const StepResultView = lazy(() => import('../components/StepResultView'));
const ShotRegenerationDialog = lazy(() => import('../components/ShotRegenerationDialog'));
const ProjectReadinessDialog = lazy(() => import('../components/ProjectReadinessDialog'));
const AssetRecoveryDialog = lazy(() => import('../components/AssetRecoveryDialog'));
const ProductionSettingsDialog = lazy(() => import('../components/ProductionSettingsDialog'));
const ProductionRecordsDialog = lazy(() => import('./ProductionRecordsDialog'));
const PlanningResultEditor = lazy(() => import('../components/PlanningResultEditor'));

export type WorkbenchRepairDestination = 'projects' | 'models' | 'characters';

type WorkbenchProps = {
  project: ProjectDocument;
  workspace: WorkspaceView;
  action: Action;
  notify: (message: string, error?: boolean) => void;
  onRegisterSave: (callback: (() => Promise<boolean>) | null) => void;
  outputRequest?: StepOutputSelection;
  onOutputConsumed: () => void;
  onOpenOutput: (selection: StepOutputSelection) => void;
  onNavigate: (destination: WorkbenchRepairDestination, modelId?: string) => Promise<boolean>;
};

export default function Workbench({ project, workspace, action, notify, onRegisterSave, outputRequest, onOutputConsumed, onOpenOutput, onNavigate }: WorkbenchProps) {
  const confirm = useConfirmation();
  const { session, state: edits, ready, storageError, canPersistDraft, checkpoint } = useProjectEdits(project, workspace.system.dataDirectory);
  const [retryingDraft, setRetryingDraft] = useState(false);
  async function retryDraft() {
    if (retryingDraft) return;
    setRetryingDraft(true);
    try { await checkpoint(); }
    finally { setRetryingDraft(false); }
  }
  const content = edits.present;
  const dirtyShot = !sameContent(content.shots, edits.base.shots);
  const dirtyProject = !sameContent({ ...content, shots: undefined }, { ...edits.base, shots: undefined });
  const stageConfiguration = useStageConfigurationDraft(project.id, content.workflow, workspace.system.dataDirectory, { brief: content.brief, originalText: content.originalText, style: content.style, profile: content.profile, creativeContext: content.creativeContext });
  const configurationError = stageConfiguration.error || (stageConfiguration.conflicts.length ? '待用配置中的项目内容或任务已在其他视图修改，请放弃待用配置后重新设置。' : '');
  const authoredProject = useMemo(() => ({ ...project, ...content, revision: edits.revision }), [project, content, edits.revision]);
  const [previewPreference, setPreviewPreference] = useState<{ runId: string; live: boolean }>();
  const availablePreview = workspace.videoPreview?.project?.id === project.id ? workspace.videoPreview : undefined;
  const showLive = previewPreference && previewPreference.runId === availablePreview?.runId ? previewPreference.live : !dirtyShot && !dirtyProject && !edits.conflict;
  const live = showLive ? availablePreview : undefined;
  const mixProject = useMemo(() => live?.project ? { ...live.project, revision: project.revision } : authoredProject, [live, project.revision, authoredProject]);
  const audioMix = usePreparedProjectMix(mixProject, workspace.assets, ready, edits.busy);
  const latestAssets = useRef(workspace.assets); latestAssets.current = workspace.assets;
  const [knownAudio] = useState(() => new Map<string, number>());
  if (audioMix.status === 'ready' && audioMix.mix) rememberAudioDurations(knownAudio, mixProject.shots, audioMix.mix, workspace.assets);
  function measuredShots(shots: Shot[]) { return measuredAudioShots(shots, latestAssets.current, knownAudio); }
  const previewShots = useMemo(() => measuredShots(content.shots), [content.shots, audioMix.status, audioMix.mix, workspace.assets]);
  const liveShots = useMemo(() => live?.project && measuredShots(live.project.shots), [live, audioMix.status, audioMix.mix, workspace.assets]);
  const playbackShots = liveShots ?? previewShots;
  const playbackRate = mixProject.profile.frameRate;
  const previewPlayable = useRef(false);
  const setPreviewPlayable = useCallback((value: boolean) => { previewPlayable.current = value; }, []);
  const activeShotFallback = content.shots.some(shot => shot.id === edits.selectedShotId) ? edits.selectedShotId : content.shots[0]?.id;
  const [shotSelection, setShotSelection] = useState<ShotSelection>();
  const shotIds = useMemo(() => content.shots.map(shot => shot.id), [content.shots]);
  const selection = normalizeSelection(shotSelection ?? { ids: activeShotFallback ? [activeShotFallback] : [], primary: activeShotFallback, anchor: activeShotFallback }, shotIds, activeShotFallback);
  const selectedShotId = selection.primary ?? activeShotFallback;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  function setSelection(next: ShotSelection) {
    selectionRef.current = next; setShotSelection(next);
    if (next.primary) session.select(next.primary);
  }
  const setSelectedShotId = (id?: string) => { if (!id) session.select(undefined); setSelection({ ids: id ? [id] : [], primary: id, anchor: id }); };
  const selectAll = () => setSelection(selectAllShots(selectionRef.current, session.state.present.shots.map(shot => shot.id)));
  const clearSelection = () => setSelection({ ids: [] });
  const [conflictDialog, setConflictDialog] = useState(false);

  const [settingsSection, setSettingsSection] = useState('planning');
  const { title, profile } = content;
  function updateSettings(patch: Partial<EditContent>, label: string) {
    const active = document.activeElement;
    const group = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? `project:${Object.keys(patch).join(',')}` : undefined;
    session.edit({ ...session.state.present, ...patch }, label, group);
  }
  const setTitle = (title: string) => updateSettings({ title }, '修改项目名称');
  const draft = content.shots.find(shot => shot.id === selectedShotId);
  const effectiveDraft = previewShots.find(shot => shot.id === selectedShotId);
  const draftCaptionTrack = draft ? sourceCaptionTrack(draft, content) : undefined;
  const captionAudio = workspace.assets.find(asset => asset.id === draft?.audioAssetId);
  const staleSpeechCaptions = draftCaptionTrack?.alignment === 'speech' && (draftCaptionTrack.sourceAssetId !== captionAudio?.id || draftCaptionTrack.sourceSha256 !== captionAudio?.sha256);
  function setDraft(next: Shot) {
    const current = session.state.present;
    const before = current.shots.find(shot => shot.id === next.id);
    if (!before) return;
    try {
      let changed = current;
      for (const kind of ['audio', 'video'] as const) {
        const field = kind === 'audio' ? 'audioAssetId' : 'videoAssetId';
        if (before[field] !== next[field] && next[field]) {
          const asset = workspace.assets.find(asset => asset.id === next[field]);
          if (!asset) throw new Error('新素材尚未读取，请稍后重新选择。');
          changed = replaceShotMedia(changed, before.id, kind, asset, () => crypto.randomUUID());
        }
      }
      const replacement = changed.shots.find(shot => shot.id === before.id)!;
      // Media replacements may fork a private plan; retain that mapping while applying other fields.
      const mediaChanged = before.audioAssetId !== next.audioAssetId || before.videoAssetId !== next.videoAssetId;
      if (mediaChanged) next = { ...next, clipEdit: replacement.clipEdit, captionTrack: replacement.captionTrack };
      if (before.clipEdit && next.durationUs !== before.durationUs) {
        if (source.status === 'loading' || source.status === 'error') throw new Error(source.error ?? '请等待真实素材时长读取完成后再修改剪辑时长。');
        const startUs = replacement.clipEdit?.inUs ?? replacement.sourceInUs ?? 0;
        changed = trimShotInContext(changed, before.id, { inUs: startUs, outUs: startUs + next.durationUs }, current.profile.frameRate, source.durationUs, () => crypto.randomUUID());
        const trimmed = changed.shots.find(shot => shot.id === before.id)!;
        next = { ...next, durationUs: trimmed.durationUs, sourceInUs: trimmed.sourceInUs, audioInUs: trimmed.audioInUs, videoInUs: trimmed.videoInUs, sceneInUs: trimmed.sceneInUs, sceneDurationUs: trimmed.sceneDurationUs, clipEdit: trimmed.clipEdit };
      }
      const field = Object.keys(next).find(key => !sameContent(before[key as keyof Shot], next[key as keyof Shot]));
      const active = document.activeElement;
      const group = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? `shot:${next.id}:${field}` : undefined;
      session.edit({ ...changed, shots: changed.shots.map(shot => shot.id === next.id ? next : shot) }, '修改镜头属性', group);
      if (before.animation.transition !== next.animation.transition) {
        const previewTimeline = createTransitionTimeline(timingContent().shots, current.profile.frameRate);
        const clipIndex = previewTimeline.clips.findIndex(clip => current.shots[clip.index]?.id === next.id);
        const clip = previewTimeline.clips[clipIndex];
        if (clip) {
          const previous = previewTimeline.clips[clipIndex - 1];
          const transitionFrames = Math.min(clip.frameCount, previous?.padFrames ?? 0);
          const contextFrames = Math.max(1, Math.round(.4 * previewTimeline.rate.numerator / previewTimeline.rate.denominator));
          const startFrame = Math.max(previous?.firstFrame ?? clip.firstFrame, clip.firstFrame - contextFrames);
          const endFrame = Math.min(clip.endFrame - 1, clip.firstFrame + transitionFrames + contextFrames);
          clock.playRange(timeAtFrame(startFrame, previewTimeline.rate), timeAtFrame(endFrame, previewTimeline.rate));
        }
      }
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }
  const [transcriptDialog, setTranscriptDialog] = useState<{ project: ProjectDocument; shot: Shot; assets: AssetRecord[] }>();
  const transcriptSubmitted = useRef<TranscriptSubmission | undefined>(undefined);
  function openTranscript() {
    const current = timingContent();
    const shot = current.shots.find(shot => shot.id === selectedShotId);
    if (!shot) return;
    transcriptSubmitted.current = undefined; clock.pause();
    setTranscriptDialog(structuredClone({ project: { ...project, ...current, revision: session.state.revision }, shot, assets: workspace.assets }));
  }
  const [exporting, setExporting] = useState(false);
  const [batchExporting, setBatchExporting] = useState<{ initialSection?: 'history' }>();
  const [bulkEditing, setBulkEditing] = useState(false);
  const [planningEditor, setPlanningEditor] = useState<{ section: PlanningSection; baseline: PlanningProject; structuredDocument: boolean; options?: PlanningEditOptions }>();
  const [keyframeShotId, setKeyframeShotId] = useState<string>();
  const [captionStyleTarget, setCaptionStyleTarget] = useState<CaptionStyleTarget>();
  const captionStyleSubmitted = useRef<CaptionStyle | null | undefined>(undefined);
  function openCaptionStyle(target: CaptionStyleTarget) { captionStyleSubmitted.current = undefined; setCaptionStyleTarget(target); }
  const [stepEditor, setStepEditor] = useState<WorkflowNode>();
  const [stageEditor, setStageEditor] = useState<ResolvedWorkflowStage>();
  const [savingStageConfiguration, setSavingStageConfiguration] = useState(false);
  const configurationInFlight = useRef(false);
  const [stageView, setStageView] = useState<StageViewOptions>({});
  const stageSubmitted = useRef<WorkflowNode[] | undefined>(undefined);
  const stageProjectBaseline = useRef<ProductionConfiguration['project'] | undefined>(undefined);
  function openStage(stage: ResolvedWorkflowStage, options: StageViewOptions = {}) {
    if (options.tab !== 'run' && !stageConfiguration.ready && !stageConfiguration.error) { notify('正在恢复制作设置，请稍后重试。'); return false; }
    stageSubmitted.current = undefined; setStepEditor(undefined); setStageView(options); if (options.tab !== 'run') setSettingsSection(stage.id);
    stageProjectBaseline.current = structuredClone(stageConfiguration.projectSettings ?? { brief: content.brief, originalText: content.originalText, style: content.style, profile: content.profile, creativeContext: content.creativeContext });
    const stageId = !stageConfiguration.workflow.stages?.length && stage.id.startsWith('task:') ? stage.nodeIds[0] ?? stage.id : stage.id;
    setStageEditor({ ...stage, id: stageId, nodes: stageConfiguration.workflow.nodes });
    return true;
  }
  const [stepRepairHint, setStepRepairHint] = useState<string>();
  const [readinessDialog, setReadinessDialog] = useState<'manual' | ProjectReadiness>(), [recoveringAssets, setRecoveringAssets] = useState(false);
  const [runtimeRepair, setRuntimeRepair] = useState<ReadinessIssue>();
  const stepSubmitted = useRef<WorkflowNode | undefined>(undefined);
  function openStep(node: WorkflowNode, hint?: string) { setStageEditor(undefined); stepSubmitted.current = undefined; setStepRepairHint(hint); setStepEditor(node); }
  const [assetDialog, setAssetDialog] = useState(false);
  const [assetKind, setAssetKind] = useState<'image' | 'video'>('image');
  const [assetPath, setAssetPath] = useState('');
  const [output, setOutput] = useState<{ nodeId: string; data: JsonValue; runId: string; kind: WorkflowNode['kind']; mediaShots?: Pick<Shot, 'id' | 'title' | 'durationUs'>[]; mediaGeneration?: { kind: 'image' | 'video'; modelName: string } }>();
  const outputReadNotify = useRef(notify); outputReadNotify.current = notify;
  useEffect(() => {
    if (!outputRequest || outputRequest.projectId !== project.id) return;
    const { regeneration, candidateShotId } = outputRequest;
    if (regeneration || candidateShotId) {
      const shot = session.state.present.shots.find(shot => shot.id === (regeneration?.shotId ?? candidateShotId));
      if (!shot) outputReadNotify.current('当前项目已移除这个镜头，原制作产物仍可查看。', true);
      else {
        clock.pause();
        setRegenerationSource(regeneration && { runId: outputRequest.runId, nodeId: outputRequest.nodeId, kind: regeneration.kind, modelName: regeneration.modelName });
        regenerationRequestId.current = undefined;
        setRegenerationShotId(shot.id);
      }
      onOutputConsumed(); return;
    }
    let current = true;
    void rpc('run.step.payload', { runId: outputRequest.runId, nodeId: outputRequest.nodeId, kind: 'output' }).then(value => {
      if (!current) return;
      const payload = runStepPayloadSchema.parse(value);
      if (!payload.available) throw new Error('这个步骤尚未保存产物。');
      setOutput({ nodeId: outputRequest.nodeId, runId: outputRequest.runId, kind: outputRequest.kind, data: payload.value, mediaShots: payload.mediaShots, mediaGeneration: payload.mediaGeneration });
    }).catch(error => { if (current) outputReadNotify.current(error instanceof Error ? error.message : String(error), true); })
      .finally(() => { if (current) onOutputConsumed(); });
    return () => { current = false; };
  }, [outputRequest, project.id, onOutputConsumed]);
  const [captionEdit, setCaptionEdit] = useState<{ shot: Shot; audioAsset?: AssetRecord; context: Pick<ProjectDocument, 'clipEditSources' | 'clipEditPlans'> }>();
  const captionSubmitted = useRef<CaptionTrack | undefined>(undefined);
  const captionShot = captionEdit?.shot;
  const captionShotId = captionShot?.id;
  const [musicEditing, setMusicEditing] = useState(false);
  const [regenerationShotId, setRegenerationShotId] = useState<string>();
  const [regenerationSource, setRegenerationSource] = useState<{ runId: string; nodeId: string; kind: 'image' | 'video'; modelName: string }>();
  const regenerationRequestId = useRef<string | undefined>(undefined);
  const regenerationShot = content.shots.find(shot => shot.id === regenerationShotId);
  useEffect(() => { if (regenerationShotId && !regenerationShot) { setRegenerationShotId(undefined); setRegenerationSource(undefined); regenerationRequestId.current = undefined; } }, [regenerationShotId, regenerationShot]);
  const musicSubmitted = useRef<MusicClip[] | undefined>(undefined);
  const saveInFlight = useRef<Promise<boolean> | undefined>(undefined);
  const [savingEdits, setSavingEdits] = useState(false);
  const [outlineWidth, setOutlineWidth] = useState(() => panelWidth('vq-outline-width', 224, 184, 320));
  const [inspectorWidth, setInspectorWidth] = useState(() => panelWidth('vq-inspector-width', 304, 280, 400));
  const [outlineOpen, setOutlineOpen] = useState(() => localStorage.getItem('vq-outline-open') !== 'false');
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem('vq-inspector-open') !== 'false');
  const [focusPreview, setFocusPreview] = useState(false);
  const outlineVisible = outlineOpen && !focusPreview;
  const inspectorVisible = inspectorOpen && !focusPreview;
  const editor = useRef<HTMLDivElement>(null);
  const inspectorBody = useRef<HTMLDivElement>(null);
  useContentMotion(inspectorBody, selectedShotId ?? '');
  const [editorWidth, setEditorWidth] = useState(1280);
  const maxOutline = Math.max(184, Math.min(320, editorWidth - 400 - (inspectorVisible ? 280 : 0)));
  const actualOutline = outlineVisible ? Math.min(outlineWidth, maxOutline) : 0;
  const maxInspector = Math.max(280, Math.min(400, editorWidth - actualOutline - 400));
  const actualInspector = inspectorVisible ? Math.min(inspectorWidth, maxInspector) : 0;
  const layoutStyle = { '--outline-track': `${actualOutline}px`, '--inspector-track': `${actualInspector}px` } as CSSProperties;
  useLayoutEffect(() => {
    const element = editor.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setEditorWidth(Math.round(width)); });
    observer.observe(element); return () => observer.disconnect();
  }, [ready]);
  const timeline = useMemo(() => buildTimeline(playbackShots), [playbackShots]);
  const totalUs = timeline.at(-1)?.endUs ?? 0;
  const [clock] = useState(() => new PlaybackClock(totalUs, playbackRate));
  const [liveSelection, setLiveSelection] = useState<{ runId: string; shotId: string }>();
  const liveShot = liveShots?.find(shot => shot.id === (liveSelection?.runId === live?.runId ? liveSelection?.shotId : selectedShotId))
    ?? liveShots?.find(shot => shot.videoAssetId) ?? liveShots?.[0];
  function selectLiveShot(id: string) {
    const clip = timeline.find(item => item.shotId === id);
    if (!live || !clip) return;
    setLiveSelection({ runId: live.runId, shotId: id });
    clock.seek(clip.startUs);
  }
  function toggleProductionPreview() {
    if (!availablePreview) return;
    clock.pause();
    setPreviewPreference({ runId: availablePreview.runId, live: !live });
  }
  const selectedIndex = Math.max(0, content.shots.findIndex(shot => shot.id === selectedShotId));
  const selectedShot = content.shots[selectedIndex];
  const source = useSourceDuration(selectedShot, workspace.assets, content);
  const latestRun = workspace.runs.find(run => run.projectId === project.id && !run.regenerationSource && (!run.purpose || run.purpose === 'production'));
  const { isProductionActive, pendingProductionAction, productionLabel, isProductionInFlight, toggleProduction } = useWorkbenchProduction({
    projectId: project.id, workspace, session, stageConfiguration, configurationError, readinessDialog, action, notify,
    isConfigurationSaving: () => configurationInFlight.current,
    save: () => save(),
    pausePreview: () => clock.pause(),
    onReadinessBlocked: setReadinessDialog,
  });
  const previousPlayback = useRef({ timeline, runId: undefined as string | undefined });
  useLayoutEffect(() => {
    const previous = previousPlayback.current, runId = live?.runId;
    // The saved revision can arrive before the edit session receives it.
    if (previous.runId && !runId && project.revision !== edits.revision && !edits.conflict) return;
    previousPlayback.current = { timeline, runId };
    const { timeUs, playing } = clock.getSnapshot();
    clock.configure(totalUs, playbackRate);
    if (!runId && !previous.runId) return;
    const before = previous.timeline.find(clip => timeUs >= clip.startUs && timeUs < clip.endUs);
    const matching = timeline.find(clip => clip.shotId === before?.shotId);
    const after = matching ?? timeline.find(clip => clip.shotId === liveShot?.id);
    const previousOffset = before && matching ? timeUs - before.startUs : 0;
    const offset = after && previousOffset >= after.durationUs ? Math.max(0, after.durationUs - timeAtFrame(1, playbackRate)) : previousOffset;
    const nextTimeUs = after ? after.startUs + offset : timeUs;
    if (nextTimeUs !== timeUs) clock.seek(nextTimeUs);
    if (runId && playing && !clock.getSnapshot().playing && clock.getSnapshot().timeUs < clock.lastTimeUs) clock.toggle();
  }, [clock, timeline, totalUs, playbackRate, live?.runId, liveShot?.id, project.revision, edits.revision, edits.conflict]);
  useEffect(() => () => { clock.pause(); clock.dispose(); }, [clock]);
  useEffect(() => { if (stageEditor || stepEditor || exporting || batchExporting || bulkEditing || assetDialog || captionStyleTarget || captionShotId || musicEditing || regenerationShotId || transcriptDialog || readinessDialog || recoveringAssets || runtimeRepair) clock.pause(); }, [clock, stageEditor, stepEditor, exporting, batchExporting, bulkEditing, assetDialog, captionStyleTarget, captionShotId, musicEditing, regenerationShotId, transcriptDialog, readinessDialog, recoveringAssets, runtimeRepair]);
  const save = useCallback(async () => {
    if (saveInFlight.current) return saveInFlight.current;
    const operation = async () => {
      setSavingEdits(true);
      try {
        if (session.state.conflict) { setConflictDialog(true); return false; }
        const dirty = session.dirty;
        if (dirty) {
          const { originalText, ...captured } = session.state.present;
          const patch = originalText === session.state.base.originalText ? captured : { ...captured, originalText };
          session.beginSave();
          try {
            // A restart after the server commits must recover this save's
            // intent. A reported storage failure still permits a project save.
            await checkpoint();
            const result = await action<ProjectDocument>('project.update', { projectId: project.id, revision: session.state.revision, patch });
            if (!result) return false;
            session.saved(result);
          } finally { session.endSave(); }
        }
        if (dirty) notify('修改已保存');
        return true;
      } finally { setSavingEdits(false); }
    };
    saveInFlight.current = operation();
    try { return await saveInFlight.current; } finally { saveInFlight.current = undefined; }
  }, [action, checkpoint, notify, project.id, session]);
  const saveExplicitly = useCallback(async () => {
    const complete = beginGuideAction('project-saved'), dirty = session.dirty;
    const saved = await save();
    if (saved && dirty) complete();
    return saved;
  }, [save, session]);
  useEffect(() => {
    onRegisterSave(save);
    return () => onRegisterSave(null);
  }, [dirtyShot, dirtyProject, onRegisterSave, save]);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (dirtyShot || dirtyProject) event.preventDefault(); }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirtyShot, dirtyProject]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const insideGuideTarget = event.target instanceof Element && Boolean(event.target.closest('.driver-active-element'));
      if (document.querySelector('dialog[open]') || document.querySelector('[data-guide-popover]') && !insideGuideTarget || event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveExplicitly(); return; }
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        void changeHistory(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo'); return;
      }
      const target = event.target;
      if (event.code === 'KeyS' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (live) return;
        if (target instanceof HTMLElement && (target.closest('input,textarea,select') || target.isContentEditable)) return;
        event.preventDefault(); if (!event.repeat) void splitSelected(); return;
      }
      if (target instanceof HTMLElement && (target.closest('input,textarea,select,button,[role="slider"]') || target.isContentEditable)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat && previewPlayable.current) {
          const complete = beginGuideAction('preview-played'); clock.toggle();
          if (clock.getSnapshot().playing) complete();
        }
      }
      if (event.code === 'ArrowRight') { event.preventDefault(); clock.step(event.shiftKey ? 10 : 1); }
      if (event.code === 'ArrowLeft') { event.preventDefault(); clock.step(event.shiftKey ? -10 : -1); }
      if (event.code === 'Home') { event.preventDefault(); clock.seek(0); }
      if (event.code === 'End') { event.preventDefault(); clock.seek(totalUs); }
    }
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [clock, saveExplicitly, totalUs, selectedShotId, profile.frameRate, savingEdits, live]);
  async function selectShot(id: string, modifiers?: SelectionModifiers) {
    const complete = beginGuideAction('shot-selected'), previous = selectionRef.current;
    const transportRevision = clock.transportRevision;
    if ((saveInFlight.current || dirtyShot || dirtyProject) && !await save()) return;
    const next = updateShotSelection(selectionRef.current, session.state.present.shots.map(shot => shot.id), id, modifiers);
    setSelection(next);
    const clip = buildTimeline(timingContent().shots).find(item => item.shotId === (next.primary ?? id));
    if (clip) clock.seekIfUnchanged(transportRevision, clip.startUs);
    if (!sameContent(previous, next)) complete();
  }
  function timingContent(current = session.state.present, ids?: readonly string[]): EditContent {
    const resolved = measuredShots(current.shots);
    return { ...current, shots: resolved.map((shot, index) => !ids || ids.includes(shot.id) ? shot : current.shots[index]) };
  }
  function sceneShots(current = session.state.present) { return preserveSceneIndices(current.shots); }
  function clipStart(id?: string) { return buildTimeline(timingContent().shots).find(clip => clip.shotId === id)?.startUs ?? 0; }
  async function addShot() {
    if (!await save()) return;
    const preset = session.state.present.scenePreset;
    const sceneTemplate = preset ? { ...createSceneTemplate(preset.kind), palette: preset.palette, motion: preset.motion } : undefined;
    const shot = shotSchema.parse({ id: crypto.randomUUID(), title: `镜头 ${session.state.present.shots.length + 1}`, narration: '', visualPrompt: '', durationUs: 6_000_000, sceneTemplate });
    session.edit({ ...session.state.present, shots: [...sceneShots(), shot] }, '添加镜头');
    setSelectedShotId(shot.id);
    if (await save()) clock.seek(clipStart(shot.id));
  }
  async function editGroup(label: string, ids: readonly string[], operation: (current: EditContent) => EditContent, after?: (next: EditContent) => ShotSelection) {
    if (!ids.length || savingEdits || session.state.busy || session.state.conflict) return;
    try {
      const beforeOrder = session.state.present.shots.map(shot => shot.id);
      const check = operation(session.state.present);
      if (sameContent(check, session.state.present) || !await save()) return;
      if (session.state.conflict || !sameContent(beforeOrder, session.state.present.shots.map(shot => shot.id))) throw new Error('镜头顺序已更新，请重新选择后操作。');
      const next = operation(session.state.present);
      clock.pause(); session.edit(next, label);
      if (after) setSelection(after(next));
      else setSelection(normalizeSelection({ ...selectionRef.current, ids: [...ids] }, next.shots.map(shot => shot.id), selectedShotId));
      if (await save()) clock.seek(clipStart(selectionRef.current.primary));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }
  async function moveShot(offset: number) {
    const ids = [...selectionRef.current.ids];
    await editGroup('调整所选镜头顺序', ids, current => bulkMoveShots(current, ids, offset < 0 ? -1 : 1));
  }
  async function splitSelected() {
    if (selectionRef.current.ids.length !== 1 || savingEdits || session.state.busy || session.state.conflict) return;
    const id = selectedShotId;
    const rawBefore = session.state.present.shots.find(shot => shot.id === id);
    const before = timingContent().shots.find(shot => shot.id === id);
    const rateBefore = session.state.present.profile.frameRate;
    const localTimeUs = clock.getSnapshot().timeUs - clipStart(id);
    if (before?.locked) { notify('请先解锁镜头，再进行分割。', true); return; }
    if (!before || !canSplitShot(before, localTimeUs, session.state.present.profile.frameRate)) { notify('播放头两侧需各保留至少 0.5 秒'); return; }
    if (!await save()) return;
    try {
      const latest = session.state.present.shots.find(shot => shot.id === id);
      const fields = ['durationUs', 'sourceInUs', 'audioInUs', 'videoInUs', 'sceneInUs', 'sceneDurationUs', 'clipEdit', 'assetId', 'videoAssetId', 'audioAssetId', 'locked'] as const;
      if (!latest || !rawBefore || latest.locked || !sameContent(rateBefore, session.state.present.profile.frameRate) || fields.some(field => !sameContent(latest[field], rawBefore[field]))) throw new Error('待分割镜头的锁定、时间或素材已有修改，新输入已保留；请核对后重新分割。');
      const current = timingContent(session.state.present, [latest.id]);
      const rightId = crypto.randomUUID();
      const next = splitShotInContext(current, latest.id, localTimeUs, current.profile.frameRate, rightId);
      const left = next.shots.find(shot => shot.id === latest.id)!;
      const startUs = clipStart(id);
      session.edit(next, '分割镜头');
      clock.pause(); setSelectedShotId(rightId);
      if (await save()) clock.seek(startUs + left.durationUs);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }
  async function trimClip(id: string, inUs: number, outUs: number, expectedRevision?: number) {
    if (selectionRef.current.ids.length !== 1 || savingEdits || session.state.busy || session.state.conflict) return;
    if (expectedRevision !== undefined && expectedRevision !== session.state.revision) { notify('项目已更新，请重新调整入出点', true); return; }
    const raw = session.state.present.shots.find(item => item.id === id);
    const rateBefore = session.state.present.profile.frameRate;
    if (!raw || id !== selectedShotId) return;
    if (raw.locked) { notify('请先解锁镜头，再调整入出点。', true); return; }
    if (source.status === 'loading' || source.status === 'error') { notify(source.error ?? '请等待素材时长读取完成后再调整入出点', true); return; }
    try {
      const current = timingContent(session.state.present, [id]);
      const check = trimShotInContext(current, id, { inUs, outUs }, current.profile.frameRate, source.durationUs, () => crypto.randomUUID());
      if (sameContent(check, current) || !await save()) return;
      const latest = session.state.present.shots.find(item => item.id === id);
      const fields = ['durationUs', 'sourceInUs', 'audioInUs', 'videoInUs', 'sceneInUs', 'clipEdit', 'videoAssetId', 'audioAssetId', 'locked'] as const;
      if (!latest || !sameContent(rateBefore, session.state.present.profile.frameRate) || fields.some(field => !sameContent(latest[field], raw[field]))) throw new Error('镜头素材或剪辑范围已有修改，请重新调整入出点。');
      const live = timingContent(session.state.present, [id]);
      const next = trimShotInContext({ ...live, shots: sceneShots(live) }, id, { inUs, outUs }, live.profile.frameRate, source.durationUs, () => crypto.randomUUID());
      clock.pause(); session.edit(next, '调整镜头入出点'); setSelectedShotId(id);
      if (await save()) clock.seek(clipStart(id));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }
  async function reorderClip(id: string, targetIndex: number, expectedRevision: number, groupIds?: readonly string[]) {
    if (savingEdits || session.state.busy || session.state.conflict) return;
    if (expectedRevision !== session.state.revision) { notify('项目已更新，请重新拖动镜头', true); return; }
    const ids = groupIds?.length ? [...groupIds] : [id];
    await editGroup('拖动所选镜头排序', ids, current => bulkReorderShots(current, ids, targetIndex), next => normalizeSelection({ ids, primary: id, anchor: selectionRef.current.anchor }, next.shots.map(shot => shot.id), id));
  }
  async function duplicateShot() {
    const ids = [...selectionRef.current.ids], newIds = Object.fromEntries(ids.map(id => [id, crypto.randomUUID()]));
    await editGroup('复制所选镜头', ids, current => bulkDuplicateShots(current, ids, newIds), next => normalizeSelection({ ids: ids.map(id => newIds[id]), primary: newIds[selectedShotId ?? ''] ?? newIds[ids[0]], anchor: newIds[ids[0]] }, next.shots.map(shot => shot.id)));
  }
  async function removeShots(ids: readonly string[], single = false) {
    if (!ids.length) return;
    const before = structuredClone(session.state.present.shots.filter(shot => ids.includes(shot.id)));
    if (before.length !== ids.length) { notify('镜头已移除，请重新选择。', true); return; }
    const locked = before.find(shot => shot.locked);
    if (locked) { notify(`镜头“${locked.title}”已锁定，请先解锁。`, true); return; }
    const subject = single ? `镜头「${before[0].title}」` : `${ids.length} 个镜头`;
    if (!await confirm({ title: single ? '删除镜头？' : '移除所选镜头？', description: `将移除${single ? '' : ' '}${subject}及其旁白、字幕和运镜设置。素材文件会保留，移除后可通过撤销恢复。`, confirmLabel: '确认移除' })) return;
    await editGroup(single ? '移除镜头' : '移除所选镜头', ids, current => {
      if (!sameContent(before, current.shots.filter(shot => ids.includes(shot.id)))) throw new Error('待移除镜头有新的修改，输入已保留；请核对后重新移除。');
      return bulkRemoveShots(current, ids);
    }, next => {
      const id = next.shots[Math.min(selectedIndex, next.shots.length - 1)]?.id;
      if (single) return normalizeSelection(selectionRef.current, next.shots.map(shot => shot.id), id);
      session.select(id); return { ids: id ? [id] : [], primary: id, anchor: id };
    });
  }
  function removeShot() { return removeShots([...selectionRef.current.ids]); }
  async function changeHistory(direction: 'undo' | 'redo') {
    if (session.state.busy || savingEdits || session.state.conflict) return;
    const wasSaved = !session.dirty;
    session[direction](); clock.pause();
    if (wasSaved) await save();
  }
  function openCaptionEditor() {
    const shot = timingContent().shots.find(shot => shot.id === selectedShotId);
    if (shot) {
      captionSubmitted.current = undefined;
      setCaptionEdit({ shot: structuredClone(shot), context: structuredClone({ clipEditSources: session.state.present.clipEditSources, clipEditPlans: session.state.present.clipEditPlans }), audioAsset: workspace.assets.find(asset => asset.id === shot.audioAssetId) });
    }
  }
  function openMusicEditor() {
    musicSubmitted.current = undefined;
    setMusicEditing(true);
  }
  function currentCaptionShot() {
    const shot = timingContent().shots.find(shot => shot.id === captionShotId);
    if (!shot || !captionShot) throw new Error('镜头已被移除，当前字幕草稿未应用。');
    const fields = ['narration', 'durationUs', 'sourceInUs', 'audioInUs', 'sceneInUs', 'sceneDurationUs', 'audioAssetId', 'clipEdit'] as const;
    const audio = workspace.assets.find(asset => asset.id === shot.audioAssetId);
    const trackChanged = !sameContent(sourceCaptionTrack(shot, session.state.present), captionSubmitted.current ?? sourceCaptionTrack(captionShot, captionEdit?.context));
    if (trackChanged || fields.some(field => !sameContent(shot[field], captionShot[field])) || audio?.sha256 !== captionEdit?.audioAsset?.sha256 || audio?.active !== captionEdit?.audioAsset?.active) throw new Error('字幕或镜头区间已在其他视图更新，当前草稿未应用。请重新打开编辑器后核对修改。');
    return shot;
  }
  async function applyCaptions(track: CaptionTrack) {
    if (session.state.conflict || session.state.busy) return false;
    const shot = currentCaptionShot();
    const parsed = captionTrackSchema.parse(track);
    const audio = workspace.assets.find(asset => asset.id === shot.audioAssetId);
    if (parsed.alignment === 'speech' && (parsed.sourceAssetId !== audio?.id || parsed.sourceSha256 !== audio?.sha256)) { notify('旁白音频已更换，请重新识别或手动校正字幕。', true); return false; }
    session.edit({ ...session.state.present, shots: session.state.present.shots.map(item => item.id === shot.id ? { ...item, captionTrack: parsed } : item) }, '编辑字幕');
    captionSubmitted.current = parsed;
    return save();
  }
  async function applyMusic(musicClips: MusicClip[], baseline: MusicClip[]) {
    if (session.state.conflict || session.state.busy) return false;
    if (!sameContent(session.state.present.musicClips, baseline) && !sameContent(session.state.present.musicClips, musicSubmitted.current)) throw new Error('背景音乐已在其他视图更新，当前草稿未应用。请重新打开编辑器后核对修改。');
    session.edit({ ...session.state.present, musicClips }, '编辑背景音乐');
    musicSubmitted.current = musicClips;
    return save();
  }
  async function generateShotCandidate(input: { kind: ShotCandidateKind; modelId?: string; instruction?: string }) {
    if (savingEdits || session.state.busy || session.state.conflict || !await save()) return null;
    const shot = session.state.present.shots.find(shot => shot.id === regenerationShotId);
    if (!shot) throw new Error('镜头已被移除，请重新选择镜头。');
    if (shot.locked) throw new Error('请先解锁镜头，再重新生成。');
    if (regenerationSource && !regenerationRequestId.current) regenerationRequestId.current = crypto.randomUUID();
    const result = await action<{ id: string }>('shot.regenerate', { projectId: project.id, shotId: shot.id, revision: session.state.revision, ...input, ...(regenerationSource ? { source: { runId: regenerationSource.runId, nodeId: regenerationSource.nodeId, requestId: regenerationRequestId.current } } : {}) }, '当前镜头已开始生成候选');
    if (result) regenerationRequestId.current = undefined;
    return result;
  }
  async function applyCandidate(candidate: ShotCandidate, fields?: ShotCandidateField[]) {
    if (savingEdits || session.state.busy || session.state.conflict) return false;
    if (candidate.projectId !== project.id || candidate.shotId !== regenerationShotId) throw new Error('候选与当前镜头不匹配。');
    const shot = session.state.present.shots.find(shot => shot.id === candidate.shotId);
    if (!shot) throw new Error('镜头已被移除，候选尚未应用。');
    applyShotCandidate(shot, candidate, fields);
    if (!await save()) return false;
    session.beginSave();
    try {
      const result = await action<ProjectDocument>('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, fields, revision: session.state.revision });
      if (!result) return false;
      session.applySaved(result, '应用镜头候选');
      notify('镜头候选已应用，可撤销恢复');
      return true;
    } finally { session.endSave(); }
  }
  async function applyCaptionStyle(value: CaptionStyle | null, baseline: ProjectDocument) {
    if (!captionStyleTarget || session.state.conflict || session.state.busy) return false;
    if (baseline.id !== project.id) throw new Error('字幕样式不属于当前项目。');
    const next = applyCaptionStyleEdit(session.state.present, baseline, captionStyleTarget, value, captionStyleSubmitted.current);
    session.edit(next, captionStyleTarget.mode === 'project' ? '修改项目字幕样式' : '修改镜头字幕样式');
    captionStyleSubmitted.current = value;
    return save();
  }
  function transcriptBaseline(baseline: ProjectDocument) {
    if (!transcriptDialog || baseline.id !== project.id) throw new Error('文稿剪辑不属于当前项目。');
    const current = timingContent(session.state.present, [transcriptDialog.shot.id]);
    assertTranscriptBaseline(current, baseline, transcriptDialog.shot.id, workspace.assets, transcriptDialog.assets, transcriptSubmitted.current);
    return current;
  }
  async function applyTranscript(action: TranscriptEditAction, baseline: ProjectDocument, assetsBaseline: readonly AssetRecord[]) {
    if (session.state.conflict || session.state.busy || !transcriptDialog) return false;
    const result = applyTranscriptEdit(timingContent(session.state.present, [transcriptDialog.shot.id]), baseline, transcriptDialog.shot.id, action, workspace.assets, assetsBaseline, () => crypto.randomUUID(), transcriptSubmitted.current);
    clock.pause(); session.edit(result.content, action.kind === 'restore' ? '恢复原始音视频与字幕' : '删除文稿音视频区间');
    transcriptSubmitted.current = result.submission;
    const saved = await save();
    if (saved) clock.seek(clipStart(transcriptDialog.shot.id));
    return saved;
  }
  async function detectSilence(options: TranscriptSilenceOptions, baseline: ProjectDocument, signal: AbortSignal) {
    signal.throwIfAborted(); transcriptBaseline(baseline);
    if (session.state.conflict || !await save()) throw new Error('请先保存镜头修改，再检测实际停顿。');
    signal.throwIfAborted(); transcriptBaseline(baseline);
    const result = silenceDetectionSchema.parse(await rpc('audio.silence', { projectId: project.id, shotId: transcriptDialog!.shot.id, revision: session.state.revision, ...options }));
    signal.throwIfAborted(); transcriptBaseline(baseline);
    return result;
  }
  async function previewTranscript(candidate: ProjectDocument, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!transcriptDialog) throw new Error('文稿剪辑窗口已关闭。');
    const current = transcriptBaseline(transcriptDialog.project), shotId = transcriptDialog.shot.id;
    const candidateShot = candidate.shots.find(shot => shot.id === shotId), liveShot = current.shots.find(shot => shot.id === shotId);
    if (!candidateShot || !liveShot) throw new Error('试听镜头已移除，请重新选择。');
    const fields = ['durationUs', 'sourceInUs', 'audioInUs', 'videoInUs', 'sceneInUs', 'sceneDurationUs', 'sceneIndex', 'clipEdit', 'captionTrack', 'assetId', 'audioAssetId', 'videoAssetId'] as const;
    const replacement = { ...liveShot, ...Object.fromEntries(fields.map(field => [field, candidateShot[field]])) };
    const sources = new Map(current.clipEditSources.map(value => [value.id, value])), plans = new Map(current.clipEditPlans.map(value => [value.id, value]));
    for (const value of candidate.clipEditSources ?? []) if (!sources.has(value.id)) sources.set(value.id, value);
    for (const value of candidate.clipEditPlans ?? []) if (!plans.has(value.id)) plans.set(value.id, value);
    return prepareAudioMixPreview({ ...project, ...current, revision: session.state.revision, shots: current.shots.map(shot => shot.id === shotId ? replacement : shot), clipEditSources: [...sources.values()], clipEditPlans: [...plans.values()] }, signal);
  }
  function openPlanningEditor(section: PlanningSection, options?: PlanningEditOptions) {
    if (isProductionActive || savingEdits || session.state.busy || session.state.conflict) return;
    const current = session.state.present;
    if (options?.shotId) {
      const shot = current.shots.find(item => item.id === options.shotId);
      if (!shot || shot.locked) { notify(shot ? '请先解锁镜头，再修改分镜。' : '镜头已移除，请重新选择。', true); return; }
    }
    clock.pause();
    const manualPlanningFields = current.workflow.production.manualPlanningFields;
    const structuredDocument = section !== 'script' && Boolean(manualPlanningFields?.[section]);
    setPlanningEditor({ section, options, structuredDocument, baseline: structuredClone({ title: current.title, brief: current.brief, style: current.style, profile: options?.profile ?? current.profile, manualPlanningFields, creativeContext: current.creativeContext ?? undefined, shots: current.shots }) });
  }
  async function savePlanning(change: PlanningChange) {
    if (!planningEditor) return false;
    if (isProductionActive) throw new Error('制作正在进行，完成或停止后再修改策划内容。');
    if (savingEdits || session.state.busy) throw new Error('正在保存项目，请稍后重试。');
    if (session.state.conflict) throw new Error('项目已有外部修改，请先关闭窗口并比较合并，输入会保留到关闭前。');
    const shotId = planningEditor.options?.shotId;
    if (shotId && (change.kind !== 'script' || change.shots.length !== 1 || change.shots[0].id !== shotId || change.newShots?.length || change.creativeContext !== undefined)) {
      throw new Error('只能保存当前镜头的修改。');
    }
    if (planningEditor.options?.addShot && (change.kind !== 'script' || change.shots.length || change.creativeContext !== undefined)) {
      throw new Error('只能保存新增的镜头。');
    }
    const next = applyPlanningEdit(session.state.present, planningEditor.baseline, change);
    if (planningEditor.options?.storyboard && change.kind === 'script') {
      const { production } = next.workflow;
      const manualPlanningSteps = [...new Set([...(production.manualPlanningSteps ?? []), 'script' as const])];
      next.workflow = { ...next.workflow, production: { ...production, manualPlanningSteps } };
    }
    session.edit(next, shotId ? '修改镜头内容' : `修改${planningLabels[change.kind]}`);
    const saved = await save();
    if (saved) planningEditor.options?.onSaved?.(next.creativeContext);
    return saved;
  }
  async function applyBulk(request: BulkShotRequest) {
    if (session.state.conflict) throw new Error('项目已有外部修改，请先关闭窗口并比较合并，当前草稿会保留。');
    if (session.state.busy || savingEdits) throw new Error('正在保存项目，请稍后重试。');
    const current = request.changes.durationUs === undefined ? session.state.present : timingContent(session.state.present, request.ids);
    const targets = current.shots.filter(shot => request.ids.includes(shot.id));
    if (request.changes.durationUs !== undefined && request.sourceKey !== sourceDurationsKey(targets, workspace.assets)) throw new Error('所选镜头的素材已更新，请关闭后重新读取时长。');
    const next = applyBulkShotEdit(current, request.baseline, request.ids, request.changes, request.sourceDurations);
    clock.pause(); session.edit(next, '批量修改镜头');
    return save();
  }
  async function applyOutput() {
    if (!output || !await confirm({ title: '应用步骤产物？', description: `将把此步骤的产物应用到“${project.title}”，替换对应的分镜、素材、风格或运镜设置。当前编辑会先保存，应用后可撤销。`, confirmLabel: '确认应用', variant: 'primary' }) || !await save()) return;
    session.beginSave();
    try {
      const result = await action<ProjectDocument>('node.apply', { runId: output.runId, nodeId: output.nodeId, revision: session.state.revision }, '步骤产物已应用');
      if (result) { session.applySaved(result, '应用步骤产物'); setOutput(undefined); }
    } finally { session.endSave(); }
  }
  async function saveStep(node: WorkflowNode) {
    if (session.state.conflict) throw new Error('项目已有新修订，请先比较草稿后再保存步骤。');
    const current = session.state.present.workflow.nodes.find(item => item.id === node.id);
    if (!current || !sameContent(current, stepSubmitted.current ?? stepEditor)) throw new Error('步骤已在其他视图更新，当前输入已保留，请核对后重新打开。');
    session.edit({ ...session.state.present, workflow: { ...session.state.present.workflow, nodes: session.state.present.workflow.nodes.map(item => item.id === node.id ? node : item) } }, '调整步骤设置');
    stepSubmitted.current = node;
    return save();
  }
  async function saveStage(nodes: WorkflowNode[], configuration?: ProductionConfiguration) {
    if (isProductionInFlight()) { notify('正在提交制作操作，请稍后保存配置。', true); return false; }
    if (configurationInFlight.current) return false;
    if (!stageEditor || session.state.conflict) { notify('项目已有新修订，请先比较草稿后再保存阶段配置。', true); return false; }
    if (configurationError) { notify(configurationError, true); return false; }
    const baseline = stageSubmitted.current ?? stageEditor.nodes;
    if (baseline.some(node => !sameContent(stageConfiguration.workflow.nodes.find(current => current.id === node.id), node))) {
      notify('阶段任务已在其他视图更新，当前输入已保留，请核对后重新打开。', true); return false;
    }
    configurationInFlight.current = true; setSavingStageConfiguration(true);
    try {
      const pending = configuration ? await stageConfiguration.saveConfiguration(nodes, configuration.production, configuration.project, stageProjectBaseline.current) : await stageConfiguration.saveNodes(nodes);
      stageSubmitted.current = nodes;
      if (isProductionActive) { notify('待用配置已保存，下次制作时使用。'); return true; }
      const merged = applyStageConfigurationDraft(session.state.present.workflow, pending);
      const fields = applyProductionProjectDraft(session.state.present, pending);
      if (merged.conflicts.length || fields.conflicts.length) { notify('制作设置已变化，待用配置已保留，请核对后重试。', true); return false; }
      session.edit({ ...session.state.present, ...fields.settings, workflow: merged.workflow }, `配置制作：${stageEditor.label}`);
      if (!await save()) return false;
      await stageConfiguration.clear();
      return true;
    } finally { configurationInFlight.current = false; setSavingStageConfiguration(false); }
  }
  async function discardStageConfiguration() {
    if (isProductionInFlight()) { notify('正在提交制作操作，请稍后调整待用配置。', true); return false; }
    if (configurationInFlight.current) return false;
    if (!await confirm({ title: '放弃待用配置？', description: `“${project.title}”已保存的下次制作配置将被清除。当前项目和本次制作会保留，清除后无法恢复这份待用配置。`, confirmLabel: '确认放弃' })) return false;
    if (isProductionInFlight() || configurationInFlight.current) return false;
    configurationInFlight.current = true; setSavingStageConfiguration(true);
    try { await stageConfiguration.clear(); return true; }
    catch (error) { notify(error instanceof Error ? error.message : '待用配置尚未放弃。', true); return false; }
    finally { configurationInFlight.current = false; setSavingStageConfiguration(false); }
  }
  async function discardEdits() {
    const before = session.state, saved = before.conflict ?? project;
    if (!await confirm({ title: '放弃未保存的草稿？', description: `“${project.title}”未保存的修改及撤销、重做历史将被清除，并重新载入已保存内容。此操作无法撤销。`, confirmLabel: '确认放弃' })) return;
    if (session.state !== before) { notify('项目内容已变化，请核对后重新放弃草稿。', true); return; }
    session.discard(saved); setConflictDialog(false);
  }
  async function repairReadiness(issue: ReadinessIssue) {
    if (issue.fix === 'step') {
      const workflow = session.state.present.workflow, nodes = workflow.nodes;
      const node = nodes.find(node => node.id === issue.nodeId) ?? nodes.filter(node => node.kind === 'subflow' && issue.nodeId?.startsWith(`${node.id}/subflow/`)).sort((left, right) => right.id.length - left.id.length)[0];
      if (!node) { notify('步骤已变化，请重新检查当前流程。', true); return; }
      if (usesManualPlanning(workflow, node)) { setReadinessDialog(undefined); openSettings('planning'); return; }
      if (issue.category === 'model' && workflow.id === 'native-video' && node.id === issue.nodeId && node.config.modelBinding === 'default' && node.config.modelOverride !== true) {
        setReadinessDialog(undefined); openSettings('materials'); return;
      }
      const hint = node.id !== issue.nodeId ? `需处理的内部步骤：${issue.nodeLabel ?? issue.nodeId}。此处使用固定版本子流程，请在来源流程修正步骤并保存新版本，再替换当前固定版本。` : undefined;
      openStep(node, hint); setReadinessDialog(undefined); return;
    }
    if (issue.fix === 'assets') { setReadinessDialog(undefined); setRecoveringAssets(true); return; }
    if (issue.fix === 'runtime') { setReadinessDialog(undefined); setRuntimeRepair(issue); return; }
    if (issue.fix === 'production') { setReadinessDialog(undefined); return; }
    if (issue.fix === 'batch-export') { setReadinessDialog(undefined); setBatchExporting({ initialSection: 'history' }); return; }
    const destination = issue.fix === 'models' ? 'models' : issue.fix === 'characters' ? 'characters' : 'projects';
    if (await onNavigate(destination, issue.modelId)) setReadinessDialog(undefined);
  }
  const displayedProject = useMemo(() => ({ ...authoredProject, shots: previewShots }), [authoredProject, previewShots]);
  const playbackProject = useMemo(() => live ? { ...mixProject, shots: playbackShots } : displayedProject, [live, mixProject, playbackShots, displayedProject]);

  function toggleOutline() { const open = !outlineVisible; const complete = beginGuideAction('outline-opened'); setFocusPreview(false); localStorage.setItem('vq-outline-open', String(open)); setOutlineOpen(open); if (open) complete(); }
  function toggleInspector() { const open = !inspectorVisible; const complete = beginGuideAction('inspector-opened'); setFocusPreview(false); localStorage.setItem('vq-inspector-open', String(open)); setInspectorOpen(open); if (open) complete(); if (document.activeElement?.closest('#project-inspector')) document.querySelector<HTMLButtonElement>('[data-inspector-toggle]')?.focus(); }
  const configuredContent = stageConfiguration.projectSettings ?? content;
  const needsCustomBrief = stageConfiguration.workflow.id !== 'native-video' && !(configuredContent.brief.trim() || configuredContent.originalText?.trim());
  const configurationIncomplete = needsCustomBrief || stageConfiguration.workflow.nodes.some(node => {
    if (!usesManualPlanning(stageConfiguration.workflow, node)) return stepGuidance(node).requiresModel && !matchingStepModels(node, workspace.models).some(model => model.id === node.modelId);
    if (node.kind === 'brief') return !configuredContent.brief.trim();
    return node.kind === 'style' ? !configuredContent.style.trim() : node.kind === 'script' && content.shots.length === 0;
  });
  function openSettings(section = settingsSection) {
    const workflow = stageConfiguration.workflow;
    const stage = resolveWorkbenchStages(workflow)?.find(stage => stage.id === section)
      ?? { id: section, label: '制作设置', description: '', nodeIds: workflow.nodes.map(node => node.id), nodes: workflow.nodes };
    if (openStage(stage, { tab: 'settings' })) beginGuideAction('production-settings-opened')();
  }
  function openProjectTool(tool: ProjectSettingsAction) {
    switch (tool) {
      case 'caption': openCaptionStyle({ mode: 'project' }); break;
      case 'music': openMusicEditor(); break;
    }
  }
  const outputKind = output?.kind;
  const assistantOutput = Boolean(output?.data && typeof output.data === 'object' && ('proposal' in output.data || 'proposalError' in output.data));
  const missingMedia = !workspace.system.ffmpegAvailable && stageConfiguration.workflow.nodes.some(node => node.kind === 'export');
  useEffect(() => { if (missingMedia) notify('导出前需准备 FFmpeg 和 FFprobe。', true); }, [missingMedia, notify]);
  const canApplyOutput = !assistantOutput && (['brief', 'script', 'style', 'assets', 'animation'].includes(outputKind ?? '') || Boolean(output?.data && typeof output.data === 'object' && 'captionTrack' in output.data));
  if (!ready) return <div className="empty-state" data-guide-loading>正在读取项目与本地草稿…</div>;
  const productionPlanning = stageEditor && {
    project: { ...content, manualPlanningFields: content.workflow.production.manualPlanningFields },
    onEdit: openPlanningEditor,
    disabledReason: isProductionActive ? '制作正在进行，完成或停止后可修改策划内容。' : savingEdits || edits.busy ? '正在保存项目，请稍后修改。' : edits.conflict ? '请先处理项目草稿冲突。' : undefined,
  };
  return <div className="workbench" onBlurCapture={() => session.endGroup()} onPointerUpCapture={event => { if (event.target instanceof HTMLInputElement && event.target.type === 'range') session.endGroup(); }}>
    <div className="project-heading">
      <div className="project-heading-copy" data-revision={edits.revision}>
        <input className="project-title-input" aria-label="项目名称" title={title} value={title} onChange={event => setTitle(event.target.value)} />
        {(dirtyShot || dirtyProject) && <p><span className="unsaved-dot">未保存</span></p>}
      </div>
      <div className="project-heading-actions">
        <div className="editor-layout-actions" role="group" aria-label="工作区面板布局">
          <IconButton data-guide="outline-toggle" label={outlineVisible ? '收起镜头导航' : '显示镜头导航'} aria-pressed={outlineVisible} onClick={toggleOutline}><PanelLeft size={16} /></IconButton>
          <IconButton data-inspector-toggle data-guide="inspector-toggle" label="切换属性面板" aria-pressed={inspectorVisible} onClick={toggleInspector}><PanelRight size={16} /></IconButton>
          <IconButton label={focusPreview ? '退出专注预览' : '专注预览'} aria-pressed={focusPreview} onClick={() => setFocusPreview(value => !value)}><ScanLine size={16} /></IconButton>
        </div>
        <IconButton
          className="editing-history-control"
          label="撤销"
          title={edits.undo.at(-1) ? `撤销：${edits.undo.at(-1)?.label}（${shortcutLabel('Z')}）` : `撤销（${shortcutLabel('Z')}）`}
          disabled={!edits.undo.length || savingEdits || Boolean(edits.conflict)}
          onClick={() => void changeHistory('undo')}
        >
          <Undo2 size={16} />
        </IconButton>
        <IconButton
          className="editing-history-control"
          label="重做"
          title={edits.redo.at(-1) ? `重做：${edits.redo.at(-1)?.label}（${shortcutLabel('Z', true)}）` : `重做（${shortcutLabel('Z', true)}）`}
          disabled={!edits.redo.length || savingEdits || Boolean(edits.conflict)}
          onClick={() => void changeHistory('redo')}
        >
          <Redo2 size={16} />
        </IconButton>
        <IconButton label={savingEdits ? '正在保存修改' : '保存修改'} disabled={savingEdits || !(dirtyShot || dirtyProject)} onClick={() => void saveExplicitly()}><Save size={16} /></IconButton>
        <ProjectMoreActions disabled={Boolean(pendingProductionAction)} onCheck={() => setReadinessDialog('manual')} />
        {stageConfiguration.workflow.production && <Button
          static
          variant="ghost"
          data-guide="view"
          className="production-settings-trigger"
          aria-label="制作设置"
          title={configurationIncomplete ? '制作设置 · 待完善' : '制作设置'}
          onClick={() => openSettings()}
        ><Settings2 size={15} />制作设置{configurationIncomplete && <span className="production-settings-trigger__pending" aria-hidden="true" />}</Button>}
        <Button
          data-guide="produce"
          aria-label={isProductionActive ? '停止制作' : productionLabel}
          busy={Boolean(pendingProductionAction)}
          disabled={!isProductionActive && (savingEdits || savingStageConfiguration)}
          onClick={event => toggleProduction(event.currentTarget)}
        >
          {!pendingProductionAction && (isProductionActive ? <Square size={15} /> : <WandSparkles size={15} />)}
          <span className="production-toggle__label" data-label="开始制作"><span>{productionLabel}</span></span>
        </Button>
        <Button data-guide="export" variant="primary" onClick={() => void save().then(saved => { if (saved) setExporting(true); })}><ArrowDownToLine size={15} />导出</Button>
      </div>
    </div>
    {!latestRun && <WorkbenchGuide project={{ ...displayedProject, workflow: stageConfiguration.workflow }} onOpenStage={stage => openStage(stage, { tab: 'run' })} />}
    {latestRun && <WorkbenchProduction
      notify={notify}
      key={latestRun.id}
      workflow={stageConfiguration.workflow}
      onConfigureStage={openStage}
      run={latestRun}
      version={workspace.version}
      action={action}
      onPausePreview={() => clock.pause()}
    />}
    {stageConfiguration.error && <div className="run-notice"><Notice kind="error"><span>{stageConfiguration.error}</span><Button onClick={stageConfiguration.retry}>重新读取制作设置</Button></Notice></div>}
    {storageError && <div className="run-notice">
      <Notice kind="error"><span>{storageError} {canPersistDraft ? '请重试保存草稿，并保留此窗口。' : '请先保存项目，并保留此窗口。'}</span>{canPersistDraft && <Button busy={retryingDraft} onClick={() => void retryDraft()}>重试保存草稿</Button>}</Notice>
    </div>}
    {edits.recovered && !edits.conflict && <div className="run-notice"><Notice><span>已恢复未保存的本地草稿，含撤销与重做历史。</span><Button variant="ghost" onClick={() => void discardEdits()}>放弃恢复草稿</Button></Notice></div>}
    {edits.conflict && <div className="run-notice"><Notice><span>项目已有新修订，人工草稿已保留。保存前请比较并合并修改。</span><Button onClick={() => setConflictDialog(true)}>比较并处理</Button></Notice></div>}
    {conflictDialog && edits.conflict && <DraftConflictDialog
      base={edits.base}
      local={content}
      remote={editContent(edits.conflict)}
      onClose={() => setConflictDialog(false)}
      onResolve={choices => { session.resolve(choices); setConflictDialog(false); }}
      onDiscard={() => void discardEdits()}
    />}
    <div className={`workbench-grid ${!outlineVisible ? 'outline-collapsed' : ''} ${!inspectorVisible ? 'inspector-collapsed' : ''}`} style={layoutStyle} ref={editor}>
      <aside data-guide="shots" className="story-panel" id="project-outline" hidden={!outlineVisible}>
        <ProjectOutline
          project={playbackProject}
          assets={workspace.assets}
          selectedShotId={live ? liveShot?.id : selectedShotId}
          selectedIds={live ? undefined : selection.ids}
          onSelectAll={live ? undefined : selectAll}
          onClearSelection={live ? undefined : clearSelection}
          onBulkEdit={live ? undefined : () => setBulkEditing(true)}
          onSelectShot={live ? selectLiveShot : selectShot}
          onAddShot={live ? undefined : addShot}
        />
        <PanelResizeHandle
          id="outline-resize"
          label="调整镜头导航宽度"
          side="left"
          value={actualOutline}
          min={184}
          max={maxOutline}
          defaultValue={224}
          onChange={setOutlineWidth}
          onCommit={value => localStorage.setItem('vq-outline-width', String(value))}
        />
      </aside>
      <PlaybackPreview
        project={playbackProject}
        draft={live ? undefined : effectiveDraft}
        assets={workspace.assets}
        timeline={timeline}
        audioMix={audioMix}
        onLevels={readAudioLevels}
        onPlayableChange={setPreviewPlayable}
        clock={clock}
        onRepair={live ? undefined : shot => { setSelectedShotId(shot.id); setAssetKind(shot.videoAssetId ? 'video' : 'image'); setAssetDialog(true); }}
        onSelect={live ? selectLiveShot : selectShot}
        onAdd={addShot}
        onError={notify}
        productionView={availablePreview && { active: Boolean(live), toggle: toggleProductionPreview }}
      />
      <aside data-guide="inspector" className="inspector" id="project-inspector" hidden={!inspectorVisible}>
        <PanelResizeHandle
          id="inspector-resize"
          label="调整属性面板宽度"
          side="right"
          value={actualInspector}
          min={280}
          max={maxInspector}
          defaultValue={304}
          onChange={setInspectorWidth}
          onCommit={value => localStorage.setItem('vq-inspector-width', String(value))}
        />
        <div className="panel-heading"><h2>{live ? '制作镜头' : '镜头属性'}</h2><IconButton label="收起属性面板" onClick={toggleInspector}><PanelRightClose size={15} /></IconButton></div>
        <div ref={inspectorBody} className="inspector-body">
          {live ? <EmptyState icon={<Film size={20} />} title={liveShot?.title ?? '制作预览'} description="点击播放器上方的「编辑项目」可修改镜头。" /> : draft ? <>
            <section className="inspector-section">
              <div className="section-heading">
                <Film size={14} />
                <h3>镜头 {(selectedIndex + 1).toString().padStart(2, '0')}</h3>
                <IconButton label={draft.locked ? '解锁镜头' : '锁定镜头'} aria-pressed={draft.locked} onClick={() => setDraft({ ...draft, locked: !draft.locked })}>{draft.locked ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}</IconButton>
              </div>
              <Field label="镜头标题"><input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field>
              <Field label="旁白"><textarea value={draft.narration} onChange={event => setDraft({ ...draft, narration: event.target.value })} placeholder="这一镜头想讲什么？" /></Field>
              <div className="field-row">
                <Field label="时长（秒）">
                  <input
                    type="number"
                    min="0.5"
                    max="600"
                    step="0.1"
                    value={(effectiveDraft ?? draft).durationUs / 1_000_000}
                    onChange={event => setDraft({ ...draft, durationUs: Math.round((event.target.valueAsNumber || .5) * 1_000_000), sourceInUs: draft.sourceInUs ?? 0, sceneInUs: draft.sceneInUs ?? 0, sceneDurationUs: draft.sceneDurationUs ?? draft.durationUs })}
                  />
                </Field>
                <Field label="转场">
                  <Select value={draft.animation.transition} onChange={event => setDraft({ ...draft, animation: { ...draft.animation, transition: event.target.value as Shot['animation']['transition'] } })}>
                    <option value="cut">直接切换</option>
                    <option value="fade">柔和叠化</option>
                    <option value="wipe">擦除显现</option>
                  </Select>
                </Field>
              </div>
              <ClipTiming
                shot={effectiveDraft ?? draft}
                context={content}
                rate={profile.frameRate}
                sourceStatus={source.status}
                sourceDurationUs={source.durationUs}
                sourceError={source.error}
                disabled={savingEdits || Boolean(edits.conflict) || selection.ids.length != 1 || draft.locked}
                onTrim={trimClip}
              />
              <div className="inspector-actions">
                <Button aria-label="保存镜头" variant="primary" busy={savingEdits} disabled={!dirtyShot} onClick={() => void saveExplicitly()}><Save size={13} />保存</Button>
                <Button disabled={draft.locked} onClick={() => setRegenerationShotId(draft.id)}><WandSparkles size={13} />AI 微调</Button>
              </div>
            </section>
            <section className="inspector-section">
              <div className="section-heading"><Image size={14} /><h3>画面与素材</h3></div>
              <SceneTemplateEditor value={draft.sceneTemplate} disabled={draft.locked} onChange={sceneTemplate => setDraft({ ...draft, sceneTemplate })} />
              <CharacterPicker value={draft.characterIds} version={workspace.version} disabled={draft.locked} onChange={characterIds => setDraft({ ...draft, characterIds })} />
              <CreativeEntityPicker
                context={content.creativeContext}
                value={draft.creativeEntityKeys}
                disabled={draft.locked}
                onChange={creativeEntityKeys => setDraft({ ...draft, creativeEntityKeys })}
              />
              <Field label="画面要求"><textarea value={draft.visualPrompt} onChange={event => setDraft({ ...draft, visualPrompt: event.target.value })} placeholder="场景、角色、构图和动作…" /></Field>
              {content.workflow.production && <Field label="镜头声音要求"><textarea value={draft.soundPrompt ?? ''} onChange={event => setDraft({ ...draft, soundPrompt: event.target.value })} placeholder="说话者、语气、环境音与音乐…" /></Field>}
              <Field label="画面素材">
                <Select value={draft.assetId ?? ''} disabled={Boolean(draft.sceneTemplate)} onChange={event => setDraft({ ...draft, assetId: event.target.value || undefined })}>
                  <option value="">使用默认画面</option>
                  {workspace.assets.filter(asset => asset.active && asset.kind === 'image' && (!asset.projectId || asset.projectId === project.id)).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                </Select>
              </Field>
              <Field label="镜头视频">
                <Select value={draft.videoAssetId ?? ''} disabled={Boolean(draft.sceneTemplate)} onChange={event => setDraft({ ...draft, videoAssetId: event.target.value || undefined, videoInUs: event.target.value ? 0 : undefined })}>
                  <option value="">使用画面素材</option>
                  {workspace.assets.filter(asset => asset.active && asset.kind === 'video' && (!asset.projectId || asset.projectId === project.id)).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                </Select>
              </Field>
              {draft.videoAssetId && <label className="field-inline"><input
                type="checkbox"
                aria-label="启用视频原声"
                checked={usesVideoAudio(draft)}
                disabled={draft.locked}
                onChange={event => setDraft({ ...draft, audioProcessing: { ...(draft.audioProcessing ?? DEFAULT_AUDIO_PROCESSING), version: 2, videoAudio: { enabled: event.target.checked, gainDb: draft.audioProcessing?.videoAudio?.gainDb ?? 0 } } })}
              />视频原声</label>}
              <Button aria-label="导入画面" className="button-full" variant="ghost" disabled={Boolean(draft.sceneTemplate)} onClick={() => { setAssetKind('image'); setAssetDialog(true); }}><Upload size={13} />导入画面</Button>
            </section>
            <section className="inspector-section">
              <div className="section-heading"><Layers size={14} /><h3>运镜</h3></div>
              <fieldset className="motion-legacy-fields" disabled={Boolean(draft.animation.keyframes?.length)}>
                <Field label={`缩放 ${draft.animation.zoom.toFixed(2)}×`}>
                  <input
                    type="range"
                    min="1"
                    max="1.5"
                    step="0.01"
                    value={draft.animation.zoom}
                    onChange={event => setDraft({ ...draft, animation: { ...draft.animation, zoom: Number(event.target.value) } })}
                  />
                </Field>
                <div className="field-row">
                  <Field label="水平移动"><input
                    type="number"
                    min="-1000"
                    max="1000"
                    value={draft.animation.panX}
                    onChange={event => setDraft({ ...draft, animation: { ...draft.animation, panX: event.target.valueAsNumber || 0 } })}
                  /></Field>
                  <Field label="垂直移动"><input
                    type="number"
                    min="-1000"
                    max="1000"
                    value={draft.animation.panY}
                    onChange={event => setDraft({ ...draft, animation: { ...draft.animation, panY: event.target.valueAsNumber || 0 } })}
                  /></Field>
                </div>
              </fieldset>
              <Button className="button-full" disabled={draft.locked} onClick={() => { clock.pause(); setKeyframeShotId(draft.id); }}>关键帧与曲线</Button>
              {draft.animation.keyframes?.length ? <p className="tiny-meta">已启用 {draft.animation.keyframes.length} 个关键帧。</p> : null}
            </section>
            <section className="inspector-section">
              <div className="section-heading"><FileText size={14} /><h3>字幕与文稿</h3></div>
              {staleSpeechCaptions && <Notice>旁白音频已更换，请打开字幕编辑器重新对齐或手动校准。</Notice>}
              <div className="inspector-actions">
                <Button disabled={audioMix.status === 'pending'} onClick={openCaptionEditor}>编辑字幕</Button>
                <Button aria-label="文稿剪辑与停顿清理" disabled={draft.locked || audioMix.status === 'pending'} onClick={openTranscript}>文稿剪辑</Button>
                <Button disabled={draft.locked} onClick={() => openCaptionStyle({ mode: 'shot', shotId: draft.id })}>镜头字幕样式</Button>
              </div>
            </section>
          </> : <EmptyState icon={<Settings2 size={20} />} title="暂无镜头属性" description="添加镜头后，即可编辑画面与旁白。" />}
        </div>
      </aside>
      <Timeline
        project={playbackProject}
        assets={workspace.assets}
        shots={playbackShots}
        timeline={timeline}
        selectedId={live ? liveShot?.id : selectedShotId}
        selectedIds={live ? undefined : selection.ids}
        onSelectAll={live ? undefined : selectAll}
        onClearSelection={live ? undefined : clearSelection}
        onBulkEdit={() => setBulkEditing(true)}
        rate={playbackRate}
        clock={clock}
        onSelect={live ? selectLiveShot : selectShot}
        onMove={moveShot}
        onDuplicate={duplicateShot}
        onRemove={removeShot}
        onSplit={splitSelected}
        onReorder={reorderClip}
        onTrim={trimClip}
        sourceDurationUs={source.durationUs}
        sourceStatus={source.status}
        onOpenMusic={live ? undefined : openMusicEditor}
        editingDisabled={!live && (savingEdits || Boolean(edits.conflict))}
        readOnly={Boolean(live)}
      />
    </div>
    {keyframeShotId && content.shots.some(shot => shot.id === keyframeShotId) && <Suspense fallback={null}>
      <KeyframeEditor
        project={displayedProject}
        shot={content.shots.find(shot => shot.id === keyframeShotId)!}
        assets={workspace.assets}
        initialTimeUs={Math.max(0, clock.getSnapshot().timeUs - clipStart(keyframeShotId))}
        disabled={savingEdits || Boolean(edits.conflict)}
        onClose={() => setKeyframeShotId(undefined)}
        onApply={(animation, baseline, context) => { session.edit(applyKeyframeEdit(session.state.present, baseline, context, animation), "修改运镜关键帧"); session.endGroup(); setKeyframeShotId(undefined); }}
      />
    </Suspense>}
    {transcriptDialog && <Suspense fallback={null}>
      <TranscriptEditingDialog
        project={transcriptDialog.project}
        shot={transcriptDialog.shot}
        assets={transcriptDialog.assets}
        disabled={savingEdits || Boolean(edits.conflict)}
        onClose={() => setTranscriptDialog(undefined)}
        onApply={(ranges: readonly ClipRange[], baseline: ProjectDocument, assetsBaseline: readonly AssetRecord[]) => applyTranscript({ kind: 'delete', ranges }, baseline, assetsBaseline)}
        onRestore={(baseline, assetsBaseline) => applyTranscript({ kind: 'restore' }, baseline, assetsBaseline)}
        onDetect={detectSilence}
        onPreview={previewTranscript}
        onLevels={readAudioLevels}
      />
    </Suspense>}
    {bulkEditing && <Suspense fallback={null}>
      <BulkShotDialog
        project={displayedProject}
        ids={selection.ids}
        primaryId={selectedShotId}
        assets={workspace.assets}
        disabled={savingEdits || Boolean(edits.conflict)}
        onClose={() => setBulkEditing(false)}
        onApply={applyBulk}
        onRetry={save}
      />
    </Suspense>}
    {captionShot && <CaptionEditor
      key={captionShot.id}
      shot={captionShot}
      context={captionEdit?.context}
      rate={profile.frameRate}
      audioAsset={captionEdit?.audioAsset}
      disabled={savingEdits || Boolean(edits.conflict)}
      onClose={() => setCaptionEdit(undefined)}
      onApply={applyCaptions}
      onSeek={localUs => clock.seek(clipStart(captionShotId) + localUs)}
    />}
    {regenerationShot && <Suspense fallback={null}>
      <ShotRegenerationDialog
        key={regenerationShot.id}
        project={displayedProject}
        shot={regenerationShot}
        models={workspace.models}
        assets={workspace.assets}
        source={regenerationSource}
        onClose={() => { setRegenerationShotId(undefined); setRegenerationSource(undefined); }}
        onGenerate={generateShotCandidate}
        onApply={applyCandidate}
      />
    </Suspense>}
    {musicEditing && <MusicEditor
      clips={content.musicClips}
      assets={workspace.assets}
      durationUs={totalUs}
      onClose={() => setMusicEditing(false)}
      onApply={applyMusic}
      onImport={async path => await action<AssetRecord>('asset.import', { projectId: project.id, path, kind: 'audio' }, '音乐已导入') ?? undefined}
      onSeek={clock.seek}
    />}
    {readinessDialog && <Suspense fallback={<Notice>正在打开制作检查…</Notice>}>
      <ProjectReadinessDialog
        key={readinessDialog === 'manual' ? 'manual' : 'blocked'}
        projectId={project.id}
        version={workspace.version}
        hasUnsavedChanges={dirtyShot || dirtyProject}
        blockingReport={readinessDialog === 'manual' ? undefined : readinessDialog}
        onClose={() => setReadinessDialog(undefined)}
        onRepair={issue => void repairReadiness(issue)}
        onError={message => notify(message, true)}
      />
    </Suspense>}
    {recoveringAssets && <Suspense fallback={null}><AssetRecoveryDialog project={project} directory={workspace.system.dataDirectory} onClose={() => setRecoveringAssets(false)} /></Suspense>}
    {runtimeRepair && <Dialog title="媒体引擎修复建议" onClose={() => setRuntimeRepair(undefined)}>
      <div className="dialog__body"><Notice kind="error">{runtimeRepair.message}</Notice><p>{runtimeRepair.hint}</p></div>
      <div className="dialog__footer"><Button onClick={() => setRuntimeRepair(undefined)}>关闭</Button><Button onClick={() => void action('runtime.reconnect', {}, '已请求重新连接执行器，请重新检查媒体引擎。')}>重新连接执行器</Button></div>
    </Dialog>}
    {stageEditor && <Suspense fallback={null}>
      {stageView.tab === 'run' ? <ProductionRecordsDialog
        planning={productionPlanning}
        workflow={stageConfiguration.workflow}
        runId={latestRun?.id}
        version={workspace.version}
        initialStage={stageEditor.id}
        initialNodeId={stageView.nodeId}
        flatRecords={stageView.flatRecords}
        recordStages={stageView.recordStages}
        onClose={() => setStageEditor(undefined)}
        onOpenOutput={selection => { setStageEditor(undefined); onOpenOutput(selection); }}
      /> : <ProductionSettingsDialog
        planning={productionPlanning}
        onRemoveShot={id => removeShots([id], true)}
        projectId={project.id}
        projectRevision={project.revision}
        savedShotCount={project.shots.length}
        onImportReferenceAudio={async path => await action<AssetRecord>('asset.import', { projectId: project.id, path, kind: 'audio', purpose: 'reference-audio' }, '参考音频已导入') ?? undefined}
        usedEntityKeys={content.shots.flatMap(shot => shot.creativeEntityKeys ?? [])}
        project={stageConfiguration.projectSettings ?? displayedProject}
        workflow={stageConfiguration.workflow}
        workspace={workspace}
        run={latestRun}
        version={workspace.version}
        initialStage={stageEditor.id}
        initialNodeId={stageView.nodeId}
        pendingConfiguration={stageConfiguration.pending}
        configurationError={configurationError}
        onSave={value => saveStage(value.nodes, value)}
        onDiscardPending={stageConfiguration.pending ? discardStageConfiguration : undefined}
        onClose={() => setStageEditor(undefined)}
        onOpenTool={openProjectTool}
        onSectionChange={setSettingsSection}
      />}
    </Suspense>}
    {stepEditor && <StepEditor hint={stepRepairHint} node={stepEditor} workspace={workspace} onSave={saveStep} onClose={() => setStepEditor(undefined)} />}
    {exporting && <ProjectExportDialog
      project={displayedProject}
      workspace={workspace}
      action={action}
      onClose={() => setExporting(false)}
      onBatch={() => void save().then(saved => { if (saved) { setExporting(false); setBatchExporting({}); } })}
      notify={notify}
    />}
    {batchExporting && <BatchExportDialog project={displayedProject} action={action} initialSection={batchExporting.initialSection} onClose={() => setBatchExporting(undefined)} notify={notify} />}
    {captionStyleTarget && <Suspense fallback={null}>
      <CaptionStyleDialog
        key={captionStyleTarget.mode === 'shot' ? captionStyleTarget.shotId : 'project'}
        project={displayedProject}
        shot={captionStyleTarget.mode === 'shot' ? content.shots.find(shot => shot.id === captionStyleTarget.shotId) : undefined}
        assets={workspace.assets}
        mode={captionStyleTarget.mode}
        disabled={savingEdits || Boolean(edits.conflict)}
        onClose={() => setCaptionStyleTarget(undefined)}
        onApply={applyCaptionStyle}
      />
    </Suspense>}
    {assetDialog && <Dialog title={assetKind === 'video' ? '重新导入镜头视频' : '导入镜头画面'} onClose={() => setAssetDialog(false)}>
      <form onSubmit={event => { event.preventDefault(); void action<AssetRecord>('asset.import', { projectId: project.id, path: assetPath, kind: assetKind }, '画面已导入').then(result => { if (result && draft) { const current = session.state.present.shots.find(shot => shot.id === draft.id); if (current) { const next = assetKind === 'video' ? replaceShotMedia(session.state.present, current.id, 'video', result, () => crypto.randomUUID()) : session.state.present; session.edit({ ...next, shots: next.shots.map(shot => shot.id === current.id ? assetKind === 'video' ? shot : { ...shot, assetId: result.id } : shot) }, '导入镜头素材'); } setAssetDialog(false); setAssetPath(''); } }); }}>
        <div className="dialog__body">
          <Field label={assetKind === 'video' ? '视频文件路径' : '图片文件路径'}>
            <PathPicker
              label={assetKind === 'video' ? '视频文件路径' : '图片文件路径'}
              value={assetPath}
              onChange={setAssetPath}
              extensions={assetKind === 'video' ? ['mp4', 'mov', 'webm'] : ['png', 'jpg', 'jpeg', 'webp', 'svg']}
              required
              autoFocus
              placeholder={pathExample(assetKind === 'video' ? 'video' : 'image')}
            />
          </Field>
        </div>
        <div className="dialog__footer"><Button onClick={() => setAssetDialog(false)}>取消</Button><Button aria-label="导入素材" variant="primary" type="submit">导入</Button></div>
      </form>
    </Dialog>}
    {planningEditor && <Suspense fallback={null}>
      <PlanningResultEditor
        section={planningEditor.section}
        baseline={planningEditor.baseline}
        storyboard={planningEditor.options?.storyboard}
        addInitialShot={planningEditor.options?.addShot}
        shotId={planningEditor.options?.shotId}
        structuredDocument={planningEditor.structuredDocument}
        version={workspace.version}
        images={workspace.assets.filter(asset => asset.kind === 'image' && (!asset.projectId || asset.projectId === project.id))}
        onImportImage={async path => await action<AssetRecord>('asset.import', { projectId: project.id, path, kind: 'image' }, '画面已导入') ?? undefined}
        onSave={savePlanning}
        onClose={() => setPlanningEditor(undefined)}
      />
    </Suspense>}
    {output && <Dialog title="步骤产物" onClose={() => setOutput(undefined)} className="dialog--wide">
      <div className="dialog__body">
        <Suspense fallback={<p role="status">正在打开制作结果…</p>}>
          <StepResultView
            key={`${output.runId}:${output.nodeId}`}
            value={output.data}
            kind={output.kind}
            mediaShots={output.mediaShots}
            mediaGeneration={output.mediaGeneration}
            onRegenerate={(shotId, kind) => { setRegenerationSource({ runId: output.runId, nodeId: output.nodeId, kind, modelName: output.mediaGeneration?.modelName ?? "" }); regenerationRequestId.current = undefined; setRegenerationShotId(shotId); setOutput(undefined); }}
          />
        </Suspense>
      </div>
      <div className="dialog__footer">
        <Button onClick={() => setOutput(undefined)}>关闭</Button>
        {canApplyOutput && <Button aria-label="应用到项目" variant="primary" disabled={savingEdits || Boolean(edits.conflict)} onClick={() => void applyOutput()}>应用</Button>}
      </div>
    </Dialog>}
  </div>;
}

function panelWidth(key: string, fallback: number, min: number, max: number) {
  const stored = localStorage.getItem(key);
  const value = stored ? Number(stored) : fallback;
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function StepEditor({ node, workspace, onSave, onClose, hint }: { node: WorkflowNode; hint?: string; workspace: WorkspaceView; onSave: (node: WorkflowNode) => Promise<boolean>; onClose: () => void }) {
  const [draft, setDraft] = useState(node);
  const latestDraft = useRef(draft); latestDraft.current = draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const help = stepGuidance(draft);
  const models = matchingStepModels(draft, workspace.models);
  const invalidModel = Boolean(draft.modelId && !models.some(model => model.id === draft.modelId));
  async function save() {
    setBusy(true); setError('');
    try {
      if (!await onSave(draft)) { setError('步骤未保存，当前输入已保留。'); return; }
      if (!sameContent(draft, latestDraft.current)) { setError('保存期间有新修改，当前输入已保留，请再次保存。'); return; }
      onClose();
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title={node.label} onClose={onClose}><div className="dialog__body">
    {error && <Notice kind="error">{error}</Notice>}
    {hint && <Notice>{hint}</Notice>}
    <Field label="提示词与补充要求"><textarea value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} placeholder="补充规则、风格或修改要求…" rows={5} /></Field>
    {(help.capability || draft.modelId) && <Field label="使用模型" hint={help.requiresModel ? '此步骤需要选择匹配的模型才能执行。' : undefined}><Select value={draft.modelId ?? ''} disabled={!models.length && !invalidModel} aria-invalid={invalidModel || undefined} onChange={event => setDraft({ ...draft, modelId: event.target.value || undefined })}><option value="">{stepModelPlaceholder(draft, models)}</option>{invalidModel && <option value={draft.modelId} disabled>{models.length ? `当前：${stepModelLabel(draft, workspace.models)}` : '无可用模型'}</option>}{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</Select></Field>}
    {invalidModel && <Notice kind="error">{help.requiresModel ? '当前模型不可用于此步骤，请选择匹配的模型。' : '当前模型不可用于此步骤，请选择匹配的模型，或改用本地内容。'}</Notice>}
    <SkillPicker inline skills={workspace.skills} groups={workspace.skillGroups} value={draft.skillIds} onChange={skillIds => setDraft({ ...draft, skillIds })} />
    {draft.kind === 'subflow' && <SubflowInputBindings node={draft} onChange={setDraft} />}{draft.kind === 'agent' && <ToolBindings node={draft} onChange={setDraft} />}
  </div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" busy={busy} onClick={() => void save()}>保存</Button></div></Dialog>;
}
