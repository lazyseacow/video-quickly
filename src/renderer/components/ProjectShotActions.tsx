import { useCallback, useSyncExternalStore } from 'react';
import { Copy, MoveDown, MoveUp, Scissors, Trash2 } from 'lucide-react';
import type { FrameRate, Shot } from '@video-quickly/contracts';
import { canSplitShot } from '@video-quickly/video/editing';
import type { PlaybackClock } from '../lib/playback';
import { ProjectActionPopover } from './ProjectMoreActions';

export default function ProjectShotActions({ shot, index, shotCount, selectionCount, clipStartUs, rate, clock, disabled, onMove, onDuplicate, onRemove, onSplit }: {
  shot?: Shot;
  index: number;
  shotCount: number;
  selectionCount: number;
  clipStartUs?: number;
  rate: FrameRate;
  clock: PlaybackClock;
  disabled: boolean;
  onMove: (offset: number) => Promise<void>;
  onDuplicate: () => Promise<void>;
  onRemove: () => Promise<void>;
  onSplit: () => Promise<void>;
}) {
  const singleSelected = selectionCount === 1;
  const readCanSplit = useCallback(() => !disabled && singleSelected && shot && !shot.locked && clipStartUs !== undefined
    ? canSplitShot(shot, clock.getSnapshot().timeUs - clipStartUs, rate)
    : false, [clock, clipStartUs, disabled, rate, shot, singleSelected]);
  const splitAvailable = useSyncExternalStore(clock.subscribe, readCanSplit);
  const unavailable = disabled || !selectionCount;
  return <ProjectActionPopover label="镜头操作" groupLabel="所选镜头操作" iconOnly disabled={unavailable} actions={[
    { label: '向前移动', icon: MoveUp, disabled: unavailable || singleSelected && index === 0, onSelect: () => onMove(-1) },
    { label: '向后移动', icon: MoveDown, disabled: unavailable || singleSelected && index === shotCount - 1, onSelect: () => onMove(1) },
    { label: '复制镜头', icon: Copy, disabled: unavailable, onSelect: onDuplicate },
    { label: '在播放头处分割镜头', icon: Scissors, disabled: !splitAvailable, shortcut: 'S', onSelect: onSplit },
    { label: '移除镜头', icon: Trash2, disabled: unavailable, onSelect: onRemove },
  ]} />;
}
