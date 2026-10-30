import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import './settings-sections.css';

export interface SettingsSection { id: string; label: string; icon?: LucideIcon; content: ReactNode }

export default function SettingsSections({ sections, preview, notice, intro, value, onValueChange, layout = 'sidebar', label = '设置分区' }: { sections: readonly SettingsSection[]; preview?: ReactNode; notice?: ReactNode; intro?: ReactNode; value?: string; onValueChange?: (value: string) => void; layout?: 'sidebar' | 'tabs'; label?: string }) {
  const id = useId();
  const [localValue, setLocalValue] = useState(sections[0]?.id ?? '');
  const selected = value ?? localValue;
  function setSelected(next: string) { setLocalValue(next); onValueChange?.(next); }
  const [previewOpen, setPreviewOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 800px)').matches);
  useEffect(() => { const media = matchMedia('(max-width: 800px)'); const update = () => setNarrow(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  const content = useRef<HTMLDivElement>(null);
  const pendingInvalid = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined>(undefined);
  const active = sections.some(section => section.id === selected) ? selected : sections[0]?.id ?? '';
  useLayoutEffect(() => { if (selected !== active) { setLocalValue(active); onValueChange?.(active); } if (content.current) content.current.scrollTop = 0; }, [active, selected, onValueChange]);
  return <div className={`settings-sections ${preview ? 'settings-sections--preview' : ''} ${layout === 'tabs' ? 'settings-sections--tabs' : ''}`} onInvalidCapture={event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
    const panel = input.closest<HTMLElement>('[data-settings-section]');
    if (!panel?.hidden) return;
    event.preventDefault();
    if (pendingInvalid.current) return;
    pendingInvalid.current = input; setSelected(panel.dataset.settingsSection!);
    requestAnimationFrame(() => { pendingInvalid.current = undefined; if (input.isConnected) input.reportValidity(); });
  }}>
    <div className="settings-sections__nav" role="tablist" aria-label={label} aria-orientation={layout === 'tabs' || narrow ? 'horizontal' : 'vertical'} onKeyDown={event => {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0 || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click(); buttons[next].focus(); buttons[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }}>{sections.map(({ id: key, label: title, icon: Icon }) => <button key={key} type="button" role="tab" id={`${id}-tab-${key}`} aria-controls={`${id}-panel-${key}`} aria-selected={active === key} tabIndex={active === key ? 0 : -1} onClick={() => setSelected(key)}>{Icon && <Icon size={16} aria-hidden="true" />}<span>{title}</span></button>)}</div>
    <div className="settings-sections__content" ref={content}>{intro}{sections.map(section => <section key={section.id} role="tabpanel" id={`${id}-panel-${section.id}`} aria-labelledby={`${id}-tab-${section.id}`} data-settings-section={section.id} hidden={active !== section.id}>{section.content}</section>)}{notice && <div className="settings-sections__notice">{notice}</div>}</div>
    {preview && <aside className={`settings-sections__preview ${previewOpen ? 'settings-sections__preview--open' : ''}`} aria-label="实时预览"><h3>实时预览</h3><button type="button" className="settings-sections__preview-toggle" aria-expanded={previewOpen} aria-controls={`${id}-preview`} onClick={() => setPreviewOpen(value => !value)}>实时预览<ChevronDown size={16} aria-hidden="true" /></button><div id={`${id}-preview`} className="settings-sections__preview-body">{preview}</div></aside>}
  </div>;
}
