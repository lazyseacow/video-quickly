import { cloneElement, createElement, isValidElement, useId, useRef, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { Check, CircleAlert, Info, LoaderCircle, X } from 'lucide-react';
import { gsap, motion, useGSAP } from '../lib/motion';
export { default as Combobox } from './Combobox';

export function Button({ children, variant = 'default', className = '', busy = false, static: isStatic = false, ...props }: ComponentProps<'button'> & { variant?: 'default' | 'primary' | 'ghost' | 'danger'; busy?: boolean; static?: boolean }) {
  return <button type="button" {...props} disabled={props.disabled || busy} className={`button button--${variant} ${isStatic ? 'button--static' : ''} ${className}`} aria-busy={busy || undefined}>{busy && <LoaderCircle className="spin" size={16} aria-hidden="true" />}{children}</button>;
}

export function IconButton({ label, children, className = '', busy = false, ...props }: ComponentProps<'button'> & { label: string; busy?: boolean }) {
  return <button type="button" {...props} title={props.title ?? label} aria-label={label} disabled={busy || props.disabled} aria-busy={busy || props['aria-busy']} className={`icon-button ${className}`}>
    {busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : children}
  </button>;
}

export function Select({ children, multiple, size, className = '', ...props }: ComponentProps<'select'>) {
  return <select {...props} className={`select ${className}`} multiple={multiple} size={size}>{!multiple && size === undefined && <button type="button" className="select-value">{createElement('selectedcontent', { className: 'select-value__text' })}</button>}{children}</select>;
}

export type FieldControlProps = { id: string; 'aria-describedby'?: string };

export function Field({ label, hint, required = false, children, className = '' }: { label: string; hint?: string; required?: boolean; children: ReactNode | ((field: FieldControlProps) => ReactNode); className?: string }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const title = <>{label}{required && <span className="field__required" aria-hidden="true">*</span>}</>;
  const description = hint && <span id={hintId} className="field__hint">{hint}</span>;
  if (typeof children === 'function') return <div className={`field ${className}`}>
    <label htmlFor={id} className="field__label">{title}</label>
    {children({ id, 'aria-describedby': hintId })}
    {description}
  </div>;
  const control = isValidElement<Record<string, unknown>>(children) && (children.type === Select || typeof children.type === 'string' && ['input', 'select', 'textarea'].includes(children.type))
    ? cloneElement(children, { 'aria-label': children.props['aria-label'] ?? label, ...(hintId ? { 'aria-describedby': [children.props['aria-describedby'], hintId].filter(Boolean).join(' ') } : {}) })
    : children;
  return <label className={`field ${className}`}><span className="field__label">{title}</span>{control}{description}</label>;
}

type DialogProps = {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onDismissStart?: () => void;
  className?: string;
  role?: 'dialog' | 'alertdialog';
  descriptionId?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  dismissOnBackdrop?: boolean;
  dismissDisabled?: boolean;
};

export function Dialog({ title, children, onClose, onDismissStart, className = '', role, descriptionId, initialFocus, dismissOnBackdrop = true, dismissDisabled = false }: DialogProps) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const dismiss = useRef<(() => void) | undefined>(undefined);
  const latestClose = useRef(onClose); latestClose.current = onClose;
  const latestDismissStart = useRef(onDismissStart); latestDismissStart.current = onDismissStart;
  useGSAP((_context, contextSafe) => {
    const dialog = ref.current;
    const content = surface.current;
    if (!dialog || !content) return;
    dialog.showModal();
    (initialFocus?.current ?? content.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])'))?.focus({ preventScroll: true });
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    let closing = false;
    let exit: gsap.core.Tween | undefined;
    content.inert = false;
    // Keep one lifecycle for the open dialog. Rebuilding a matchMedia context
    // during dismissal would kill its onComplete and lose the close request.
    const enter = gsap.fromTo(content, { opacity: 0, y: 12, scale: .985 }, { opacity: 1, y: 0, scale: 1, duration: preference.matches ? 0 : motion.enter, ease: motion.ease, clearProps: 'transform,opacity' });
    const close = () => {
      if (closing) return;
      closing = true;
      latestDismissStart.current?.();
      enter.kill();
      content.inert = true;
      exit = gsap.to(content, { autoAlpha: 0, y: 6, scale: .995, duration: preference.matches ? 0 : motion.exit, ease: motion.ease, overwrite: 'auto', onComplete: () => latestClose.current() });
    };
    dismiss.current = contextSafe?.(close) ?? close;
    const updatePreference = () => {
      if (preference.matches) (closing ? exit : enter)?.progress(1);
    };
    preference.addEventListener('change', updatePreference);
    return () => { preference.removeEventListener('change', updatePreference); enter.kill(); exit?.kill(); dismiss.current = undefined; content.inert = false; if (dialog.open) dialog.close(); };
  }, { scope: ref });
  const requestDismiss = () => { if (!dismissDisabled) dismiss.current?.(); };
  const closedby = dismissDisabled ? 'none' : dismissOnBackdrop ? 'any' : 'closerequest';
  return <dialog ref={ref} role={role} className={`dialog ${className}`} aria-labelledby={titleId} aria-describedby={descriptionId}
    closedby={closedby} onCancel={event => { event.preventDefault(); event.stopPropagation(); requestDismiss(); }}>
    <div ref={surface} className="dialog__surface">
      <div className="dialog__header">
        <h2 id={titleId}>{title}</h2>
        <IconButton label="关闭对话框" disabled={dismissDisabled} onClick={requestDismiss}><X size={18} /></IconButton>
      </div>
      {children}
    </div>
  </dialog>;
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success'; children: ReactNode }) {
  const Icon = kind === 'success' ? Check : kind === 'error' ? CircleAlert : Info;
  return <div role={kind === 'error' ? 'alert' : 'status'} className={`notice notice--${kind}`}><Icon className="notice__icon" size={16} strokeWidth={1.75} aria-hidden="true" /><span className="notice__content">{children}</span></div>;
}

export function EmptyState({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-state__icon" aria-hidden="true">{icon}</div><h3>{title}</h3><p>{description}</p>{children}</div>;
}

export const statusLabels: Record<string, string> = { draft: '草稿', ready: '就绪', queued: '排队中', running: '制作中', processing: '制作中', planned: '分镜就绪', completed: '已完成', succeeded: '已完成', waiting_review: '待继续', awaiting_review: '待继续', needs_attention: '需要核对', failed: '执行失败', canceled: '已停止', cancelled: '已停止', archived: '回收站', stale: '需更新', pending: '待执行', waiting_external: '等待结果', retry_scheduled: '等待重试' };
export function Status({ value }: { value: string }) { return <span className={`status status--${value}`}><span />{statusLabels[value] ?? value}</span>; }

export function formatTime(us: number) {
  const total = Math.max(0, us / 1_000_000);
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${Math.floor(total % 60).toString().padStart(2, '0')}.${Math.floor((total % 1) * 100).toString().padStart(2, '0')}`;
}
