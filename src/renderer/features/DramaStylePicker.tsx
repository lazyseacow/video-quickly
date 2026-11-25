import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { autoUpdate, flip, offset, shift, size, useFloating } from '@floating-ui/react';
import { Check, ChevronDown, ImageIcon, X } from 'lucide-react';
import { dramaStylePresets } from '@video-quickly/contracts';
import { Button, Field, IconButton, Select } from '../components/Primitives';
import previews from '../assets/drama-style-previews.webp';

const dramaStyleCategories = { 'live-action': '真人写实', '2d': '二维动画', illustration: '绘本与工艺', '3d': '三维动画' } as const;

// Match the left-to-right, top-to-bottom order of the 5 × 2 preview sheet.
const previewIds = [
  'natural-live-action', 'urban-drama', 'period-film', 'suspense-cinema', 'cel-animation',
  'ink-wash', 'graphic-illustration', 'paper-cut', 'stylized-3d', 'clay-animation',
];

interface DramaStyleControlProps { value: string; usingTemplate: boolean; onChange(value: string): void; }

function customStyleLabel(usingTemplate: boolean) {
  return usingTemplate ? '沿用系列模板画风' : '自由画风';
}

export function DramaStylePreview({ presetId }: { presetId: string }) {
  const index = previewIds.indexOf(presetId);
  return <span className="drama-style-picker__preview" aria-hidden="true" style={index < 0 ? undefined : {
    backgroundImage: `url(${previews})`, backgroundPosition: `${index % 5 * 25}% ${index >= 5 ? 100 : 0}%`,
  }}>{index < 0 && <ImageIcon size={18} />}</span>;
}

export function DramaStyleField({ value, usingTemplate, onChange }: DramaStyleControlProps) {
  return <Field label="画风">
    <Select name="stylePresetId" value={value} onChange={event => onChange(event.target.value)}>
      <option value="">{customStyleLabel(usingTemplate)}</option>
      {Object.entries(dramaStyleCategories).map(([category, label]) => <optgroup key={category} label={label}>
        {dramaStylePresets.filter(preset => preset.category === category).map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
      </optgroup>)}
    </Select>
  </Field>;
}

export default function DramaStylePicker({ value, usingTemplate, disabled, onChange }: DramaStyleControlProps & { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const { refs, elements, floatingStyles, isPositioned, placement, update } = useFloating<HTMLButtonElement>({
    open,
    placement: 'top-start',
    strategy: 'fixed',
    middleware: [offset(8), flip(), shift({ padding: 12 }), size({
      padding: 12,
      apply({ availableHeight, elements }) {
        elements.floating.style.maxBlockSize = `min(27rem, ${Math.max(0, availableHeight)}px)`;
      },
    })],
  });
  useEffect(() => {
    if (!open || !elements.reference || !elements.floating) return;
    return autoUpdate(elements.reference, elements.floating, update);
  }, [open, elements.reference, elements.floating, update]);
  useLayoutEffect(() => {
    if (isPositioned) search.current?.focus({ preventScroll: true });
  }, [isPositioned]);
  const customLabel = customStyleLabel(usingTemplate);
  const selectedPreset = dramaStylePresets.find(preset => preset.id === value);
  const term = query.trim().toLowerCase();
  const matches = dramaStylePresets.filter(preset =>
    `${preset.name} ${dramaStyleCategories[preset.category]} ${preset.description}`.toLowerCase().includes(term));
  const showCustom = customLabel.includes(term);

  function choose(preset: string) {
    onChange(preset);
    close();
  }

  function close() {
    refs.floating.current?.hidePopover();
    refs.domReference.current?.focus({ preventScroll: true });
  }

  return <>
    <Button ref={refs.setReference} static variant="ghost" disabled={disabled} className="drama-style-picker__trigger"
      popoverTarget={id} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} aria-label="快速选择画风" aria-describedby={`${id}-value`}>
      <ImageIcon size={16} aria-hidden="true" />
      <span id={`${id}-value`}>{selectedPreset?.name ?? customLabel}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </Button>
    <div id={id} ref={refs.setFloating} style={floatingStyles} className="drama-style-picker" popover="auto" role="dialog" aria-label="选择画风"
      data-side={placement.split('-')[0]} inert={!open}
      onToggle={event => {
        const next = event.newState === 'open';
        setOpen(next);
        if (next) setQuery('');
      }}>
      <header className="drama-style-picker__header">
        <input ref={search} type="search" aria-label="搜索画风" placeholder="搜索画风" value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault(); }} />
        <IconButton label="关闭画风选择" onClick={close}><X size={16} aria-hidden="true" /></IconButton>
      </header>
      {showCustom && <Button static variant="ghost" className="drama-style-picker__custom" aria-pressed={!value} onClick={() => choose('')}>
        <ImageIcon size={16} aria-hidden="true" />{customLabel}{!value && <Check size={14} aria-hidden="true" />}
      </Button>}
      {matches.length > 0 && <div className="drama-style-picker__grid" role="group" aria-label="画风预设">
        {matches.map(preset => <Button key={preset.id} static variant="ghost" className="drama-style-picker__item" title={preset.description}
          aria-label={preset.name} aria-pressed={preset.id === value} onClick={() => choose(preset.id)}>
          <DramaStylePreview presetId={preset.id} />
          <span className="drama-style-picker__item-label">{preset.name}{preset.id === value && <Check size={14} aria-hidden="true" />}</span>
        </Button>)}
      </div>}
      {!matches.length && !showCustom && <p role="status">没有找到匹配的画风。</p>}
    </div>
  </>;
}
