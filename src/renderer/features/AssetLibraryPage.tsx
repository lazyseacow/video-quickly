import { Activity, useId, useState } from 'react';
import { Images, Users } from 'lucide-react';
import type { AssetRecord, ProjectDocument } from '@video-quickly/contracts';
import type { Action, WorkspaceView } from '../lib/types';
import CharactersPage, { CharacterEditor } from './CharactersPage';
import { AssetsPanel } from './AssetsPanel';
import './asset-library.css';

const tabs = [
  { value: 'media', label: '媒体', icon: Images },
  { value: 'characters', label: '角色', icon: Users },
] as const;
export type AssetLibraryTab = (typeof tabs)[number]['value'];

export default function AssetLibraryPage({ workspace, project, action, notify, tab, onTabChange }: {
  workspace: WorkspaceView;
  project?: ProjectDocument;
  action: Action;
  notify(message: string): void;
  tab: AssetLibraryTab;
  onTabChange(tab: AssetLibraryTab): void;
}) {
  const id = useId();
  const [reference, setReference] = useState<AssetRecord>();
  return <div className="content-page asset-library">
    <header className="page-heading asset-library__heading">
      <h1>素材库</h1>
      <div className="tabs" role="tablist" aria-label="素材库视图" onKeyDown={event => {
        const key = event.key;
        if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
        event.preventDefault();
        const next = key === 'Home' ? 'media' : key === 'End' ? 'characters' : tab === 'media' ? 'characters' : 'media';
        onTabChange(next);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === 'media' ? 0 : 1]?.focus();
      }}>
        {tabs.map(({ value, label, icon: Icon }) => <button key={value} type="button" role="tab"
          id={`${id}-tab-${value}`} aria-controls={`${id}-panel-${value}`} aria-selected={tab === value}
          tabIndex={tab === value ? 0 : -1} className={tab === value ? 'active' : ''} onClick={() => onTabChange(value)}>
          <Icon size={16} aria-hidden="true" />{label}
        </button>)}
      </div>
    </header>
    {tabs.map(({ value }) => <section key={value} role="tabpanel" id={`${id}-panel-${value}`}
      aria-labelledby={`${id}-tab-${value}`} hidden={tab !== value}>
      <Activity mode={tab === value ? 'visible' : 'hidden'}>
        {value === 'media'
          ? <AssetsPanel workspace={workspace} action={action} project={project} onCreateCharacter={setReference} />
          : <CharactersPage workspace={workspace} action={action} />}
      </Activity>
    </section>)}
    {reference && <CharacterEditor initialReference={reference} version={workspace.version} models={workspace.models} action={action}
      onClose={() => setReference(undefined)}
      onSaved={() => { setReference(undefined); notify('角色已创建'); }} />}
  </div>;
}
