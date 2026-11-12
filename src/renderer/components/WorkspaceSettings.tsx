import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react';
import { ChartNoAxesCombined, ChevronRight, CircleHelp, Moon, Sun, X } from 'lucide-react';
import { Button, IconButton } from './Primitives';
import './workspace-settings.css';

export default function WorkspaceSettings({ anchor, theme, onTheme, onCosts, onGuide, onClose }: {
  anchor: HTMLButtonElement | null; theme: 'light' | 'dark'; onTheme: (value: 'light' | 'dark') => void;
  onCosts: () => void; onGuide: () => void; onClose: () => void;
}) {
  const { refs, floatingStyles, context } = useFloating({ open: true, onOpenChange: open => { if (!open) onClose(); }, elements: { reference: anchor }, placement: 'top-start', strategy: 'fixed', middleware: [offset(8), flip(), shift({ padding: 12 })], whileElementsMounted: autoUpdate });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);
  return <FloatingPortal><FloatingFocusManager context={context} modal={false}>
    <div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps({ className: 'workspace-settings', 'aria-label': '设置' })}>
      <div className="workspace-settings__heading"><h2>设置</h2><IconButton label="关闭设置" onClick={onClose}><X size={16} /></IconButton></div>
      <div className="workspace-settings__appearance"><span>外观</span><div className="workspace-settings__themes" role="group" aria-label="外观"><button type="button" aria-label="浅色外观" aria-pressed={theme === 'light'} onClick={() => onTheme('light')}><Sun size={16} /><span>浅色</span></button><button type="button" aria-label="深色外观" aria-pressed={theme === 'dark'} onClick={() => onTheme('dark')}><Moon size={16} /><span>深色</span></button></div></div>
      <div className="workspace-settings__actions"><Button static variant="ghost" className="workspace-settings__action" aria-label="Token 消耗" onClick={onCosts}><ChartNoAxesCombined size={18} /><span>Token 消耗</span><ChevronRight size={16} /></Button><Button static variant="ghost" className="workspace-settings__action" aria-label="使用指南" onClick={onGuide}><CircleHelp size={18} /><span>使用指南</span><ChevronRight size={16} /></Button></div>
    </div>
  </FloatingFocusManager></FloatingPortal>;
}
