import { Check, ChevronDown, Film, FolderClosed, MessageSquare, Plus, type LucideIcon } from 'lucide-react';
import type { ProjectSummary } from '@video-quickly/contracts';
import { useState } from 'react';
import { Button } from './Primitives';

export type StudioMenuCommand = 'dialogue' | 'new' | 'works';

export interface StudioNavigationMenuProps {
  current?: StudioMenuCommand;
  currentEpisodeId?: string;
  episodes: readonly ProjectSummary[];
  guideLibrary: boolean;
  onChoose(command: StudioMenuCommand): void;
  onOpenEpisode(id: string): void;
}

const entries = {
  dialogue: { label: '对话', icon: MessageSquare },
  works: { label: '我的作品', icon: FolderClosed },
} satisfies Record<Exclude<StudioMenuCommand, 'new'>, { label: string; icon: LucideIcon }>;

export default function StudioNavigationMenu({ id, current, currentEpisodeId, episodes, guideLibrary, hidden, iconOnly, onChoose, onOpenEpisode }: StudioNavigationMenuProps & { id: string; hidden: boolean; iconOnly: boolean }) {
  const [recentExpanded, setRecentExpanded] = useState(true);
  const recentId = `${id}-recent-list`;

  function renderEntry(command: Exclude<StudioMenuCommand, 'new'>) {
    const { label, icon: Icon } = entries[command];
    const active = current === command;
    return <li key={command}><Button static variant="ghost" className="studio-menu__item" aria-current={active ? 'page' : undefined} aria-label={label} title={iconOnly ? label : undefined}
      data-guide={command === 'works' && guideLibrary ? 'work-library' : undefined} onClick={() => onChoose(command)}>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" /><span>{label}</span>{active && <Check size={16} aria-hidden="true" />}
    </Button></li>;
  }

  return <nav id={id} hidden={hidden} aria-label="工作室菜单" className="studio-menu__panel">
    <Button static variant="ghost" className="studio-menu__item studio-menu__create" aria-label="新建对话" title={iconOnly ? '新建对话' : undefined}
      data-guide="create-project" onClick={() => onChoose('new')}><Plus size={16} aria-hidden="true" /><span>新建对话</span></Button>
    <ul className="studio-menu__list">{renderEntry('dialogue')}{renderEntry('works')}</ul>
    <section className="studio-menu__recent" aria-labelledby={`${id}-recent`} hidden={iconOnly}>
      <h2 id={`${id}-recent`}>
        <Button static variant="ghost" className="studio-menu__item studio-menu__disclosure" aria-expanded={recentExpanded} aria-controls={recentId}
          onClick={() => setRecentExpanded(value => !value)}><span>最近分集</span><ChevronDown size={14} aria-hidden="true" /></Button>
      </h2>
      <div id={recentId} hidden={!recentExpanded}>
        {episodes.length > 0 ? <ul className="studio-menu__list">{episodes.map(episode => {
          const number = episode.drama && `第 ${episode.drama.number} 集`;
          const label = number && !episode.title.replace(/\s/g, '').includes(number.replaceAll(' ', '')) ? `${number} · ${episode.title}` : episode.title;
          const active = currentEpisodeId === episode.id;
          return <li key={episode.id}><Button static variant="ghost" className="studio-menu__item studio-menu__episode" title={label} data-recent-project-id={episode.id}
            aria-current={active ? 'page' : undefined} onClick={() => onOpenEpisode(episode.id)}><Film size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{label}</span>{active && <Check size={16} aria-hidden="true" />}</Button></li>;
        })}</ul> : <p>还没有分集</p>}
      </div>
    </section>
  </nav>;
}
