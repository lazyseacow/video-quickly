import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog } from './Primitives';
import './confirmation-dialog.css';

interface ConfirmationOptions {
  title: string;
  description: string;
  confirmLabel: string;
  variant?: 'danger' | 'primary';
}
type Confirm = (options: ConfirmationOptions) => Promise<boolean>;
interface PendingConfirmation extends ConfirmationOptions { resolve: (confirmed: boolean) => void; }
const ConfirmationContext = createContext<Confirm | undefined>(undefined);

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<PendingConfirmation>();
  const pending = useRef<PendingConfirmation | undefined>(undefined);
  const cancel = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const confirm = useCallback<Confirm>(options => new Promise(resolve => {
    if (pending.current) { resolve(false); return; }
    const next = { ...options, resolve };
    pending.current = next;
    setRequest(next);
  }), []);
  useEffect(() => () => { pending.current?.resolve(false); pending.current = undefined; }, []);
  function settle(confirmed: boolean) {
    const current = pending.current;
    if (!current) return;
    pending.current = undefined;
    setRequest(undefined);
    current.resolve(confirmed);
  }
  return <ConfirmationContext.Provider value={confirm}>{children}{request && <Dialog role="alertdialog" title={request.title} descriptionId={descriptionId} initialFocus={cancel} className="confirmation-dialog" onClose={() => settle(false)}>
    <div className="dialog__body"><p id={descriptionId}>{request.description}</p></div>
    <div className="dialog__footer"><Button ref={cancel} onClick={() => settle(false)}>取消</Button><Button variant={request.variant ?? 'danger'} onClick={() => settle(true)}>{request.confirmLabel}</Button></div>
  </Dialog>}</ConfirmationContext.Provider>;
}

export function useConfirmation() {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error('确认操作需要位于 ConfirmationProvider 中。');
  return confirm;
}
