import { useState } from 'react';
import { desktopBridge, isNativeDesktop } from '../lib/desktop';
import { FolderOpen } from 'lucide-react';
import { IconButton } from './Primitives';

export default function PathPicker({ value, onChange, label, mode = 'file', extensions, placeholder, required = false, disabled = false, autoFocus = false }: { value: string; onChange: (value: string) => void; label: string; mode?: 'file' | 'directory' | 'save'; extensions?: string[]; placeholder?: string; required?: boolean; disabled?: boolean; autoFocus?: boolean }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function choose() {
    setError(''); setBusy(true);
    try {
      const path = await desktopBridge()?.pickPath({ mode, title: label, ...(value ? { defaultPath: value } : {}), ...(extensions?.length ? { extensions } : {}) });
      if (path) onChange(path);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <><span className="path-picker"><input aria-label={label} autoFocus={autoFocus} required={required} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />{isNativeDesktop() && <IconButton label={`选择${label}`} disabled={busy || disabled} onClick={() => void choose()}><FolderOpen size={17} /></IconButton>}</span>{error && <span role="alert" className="field-error">{error}</span>}</>;
}

export async function revealFile(path: string) {
  await desktopBridge()?.revealFile(path);
}

export const nativeDesktop = isNativeDesktop();
