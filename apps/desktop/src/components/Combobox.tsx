import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, shift, size, useDismiss, useFloating, useInteractions, useListNavigation, useRole } from '@floating-ui/react';
import { Check, ChevronDown } from 'lucide-react';
import './combobox.css';

export default function Combobox({ id, label, value, items, disabled = false, required = false, placeholder = '选择或搜索', descriptionId, action, displayMode = 'id', onChange }: {
  id: string; label: string; value: string; items: readonly { id: string; label: string }[]; disabled?: boolean; required?: boolean;
  placeholder?: string; descriptionId?: string; action?: ReactNode; onChange: (value: string) => void;
  displayMode?: 'id' | 'label';
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null), list = useRef<Array<HTMLElement | null>>([]);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = items.filter(item => `${item.label} ${item.id}`.toLocaleLowerCase().includes(normalized));
  const active = activeIndex !== null && activeIndex < filtered.length ? activeIndex : null;
  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) { setQuery(''); setEditing(false); setActiveIndex(null); }
  }
  const { refs, floatingStyles, context } = useFloating({
    open, onOpenChange: changeOpen, placement: 'bottom-start', strategy: 'fixed', whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ altBoundary: true }), shift({ padding: 8, altBoundary: true }), size({ padding: 8, altBoundary: true, apply({ rects, availableHeight, elements }) {
      Object.assign(elements.floating.style, { width: `${rects.reference.width}px`, maxHeight: `${Math.max(0, Math.min(360, availableHeight))}px` });
    } })],
  });
  const reference = useCallback((element: HTMLInputElement | null) => {
    input.current = element; refs.setReference(element);
    setPortalRoot(element?.closest('dialog') ?? null);
  }, [refs.setReference]);
  const dismiss = useDismiss(context, { escapeKey: false });
  const role = useRole(context, { role: 'combobox' });
  const navigation = useListNavigation(context, { listRef: list, activeIndex: active, onNavigate: setActiveIndex, virtual: true, loop: true, enabled: !disabled && !composing });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([dismiss, role, navigation]);
  useEffect(() => { if (disabled) { setOpen(false); setQuery(''); setEditing(false); setActiveIndex(null); } }, [disabled]);
  function choose(item: typeof items[number]) { onChange(item.id); changeOpen(false); }
  return <div className={`combobox ${action ? 'combobox--with-action' : ''}`}>
    <input {...getReferenceProps({
      id, ref: reference, 'aria-label': label, 'aria-describedby': descriptionId, 'aria-autocomplete': 'list', 'aria-required': required || undefined,
      value: open && editing ? query : displayMode === 'label' ? items.find(item => item.id === value)?.label ?? value : value, disabled, placeholder: open ? '搜索名称或 ID' : placeholder,
      autoComplete: 'off', autoCapitalize: 'none', spellCheck: false,
      onFocus: () => { input.current?.select(); }, onClick: () => { changeOpen(true); if (!editing) input.current?.select(); }, onBlur: () => changeOpen(false),
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setQuery(event.target.value); setEditing(true); setOpen(true); setActiveIndex(0); },
      onCompositionStart: () => setComposing(true), onCompositionEnd: () => setComposing(false),
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); changeOpen(false); }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (open && active !== null) choose(filtered[active]);
          else if (!open) changeOpen(true);
        }
      },
    })} />
    <div className="combobox__actions">
      <button type="button" className="icon-button" tabIndex={-1} disabled={disabled} aria-label={`${open ? '收起' : '展开'}${label}列表`} aria-expanded={open} onMouseDown={event => event.preventDefault()} onClick={() => { if (open) changeOpen(false); else { input.current?.focus(); changeOpen(true); } }}><ChevronDown size={16} aria-hidden="true" /></button>
      {action}
    </div>
    {open && !disabled && <FloatingPortal root={portalRoot ?? undefined}>
      <div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps({ className: 'combobox__list', 'aria-label': `${label}列表`, onMouseDown: (event: React.MouseEvent) => event.preventDefault() })}>
        {filtered.map((item, index) => <div key={item.id} ref={element => { list.current[index] = element; }} {...getItemProps({
          active: active === index, selected: item.id === value, className: `combobox__option ${active === index ? 'combobox__option--active' : ''}`,
          onClick: () => choose(item),
        })}><span>{item.label}</span>{item.id === value && <Check size={16} aria-hidden="true" />}</div>)}
        {!filtered.length && <p className="combobox__empty" aria-live="polite">没有匹配的{label.replace(/ ID$/, '')}，请更换关键词。</p>}
      </div>
    </FloatingPortal>}
  </div>;
}
