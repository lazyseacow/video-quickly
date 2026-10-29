import { cloneElement, isValidElement, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Check, CircleAlert, Info, LoaderCircle, X } from 'lucide-react';
import { gsap, motion, useGSAP } from '../lib/motion';

export function Button({ children, variant = 'default', className = '', busy = false, static: isStatic = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger'; busy?: boolean; static?: boolean }) {
  return <button type="button" {...props} disabled={props.disabled || busy} className={`button button--${variant} ${isStatic ? 'button--static' : ''} ${className}`} aria-busy={busy || undefined}>{busy && <LoaderCircle className="spin" size={16} aria-hidden="true" />}{children}</button>;
}

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" {...props} title={props.title ?? label} aria-label={label} className={`icon-button ${className}`}>{children}</button>;
}

export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  const hintId = useId();
  const control = isValidElement<Record<string, unknown>>(children) && typeof children.type === 'string' && ['input', 'select', 'textarea'].includes(children.type)
    ? cloneElement(children, { 'aria-label': children.props['aria-label'] ?? label, ...(hint ? { 'aria-describedby': [children.props['aria-describedby'], hintId].filter(Boolean).join(' ') } : {}) })
    : children;
  return <label className={`field ${className}`}><span className="field__label">{label}</span>{control}{hint && <span id={hintId} className="field__hint">{hint}</span>}</label>;
}

export function Dialog({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const dismiss = useRef<(() => void) | undefined>(undefined);
  const latestClose = useRef(onClose); latestClose.current = onClose;
  useGSAP(() => {
    const dialog = ref.current;
    const content = surface.current;
    if (!dialog || !content) return;
    dialog.showModal();
    content.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])')?.focus({ preventScroll: true });
    const media = gsap.matchMedia();
    media.add({ reduced: '(prefers-reduced-motion: reduce)', animated: '(prefers-reduced-motion: no-preference)' }, context => {
      let closing = false;
      content.inert = false;
      // Keep the surface focusable throughout its entrance.
      const tween = gsap.fromTo(content, { opacity: 0, y: 12, scale: .985 }, { opacity: 1, y: 0, scale: 1, duration: context.conditions?.reduced ? 0 : motion.enter, ease: motion.ease, clearProps: 'transform,opacity' });
      const close = () => {
        if (closing) return;
        closing = true;
        tween.kill();
        content.inert = true;
        gsap.to(content, { autoAlpha: 0, y: 6, scale: .995, duration: context.conditions?.reduced ? 0 : motion.exit, ease: motion.ease, overwrite: 'auto', onComplete: () => latestClose.current() });
      };
      const closeSafe = context.add('dismiss', close);
      dismiss.current = () => closeSafe();
      return () => { dismiss.current = undefined; content.inert = false; };
    }, dialog);
    return () => { media.revert(); if (dialog.open) dialog.close(); };
  }, { scope: ref });
  return <dialog ref={ref} className={`dialog ${className}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); dismiss.current?.(); }} onClick={event => { if (event.target === event.currentTarget) dismiss.current?.(); }}><div ref={surface} className="dialog__surface"><div className="dialog__header"><h2 id={titleId}>{title}</h2><IconButton label="关闭对话框" onClick={() => dismiss.current?.()}><X size={18} /></IconButton></div>{children}</div></dialog>;
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success'; children: ReactNode }) {
  const Icon = kind === 'success' ? Check : kind === 'error' ? CircleAlert : Info;
  return <div role={kind === 'error' ? 'alert' : 'status'} className={`notice notice--${kind}`}><Icon className="notice__icon" size={16} strokeWidth={1.75} aria-hidden="true" /><span className="notice__content">{children}</span></div>;
}

export function EmptyState({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-state__icon">{icon}</div><h3>{title}</h3><p>{description}</p>{children}</div>;
}

export const statusLabels: Record<string, string> = { draft: '草稿', ready: '就绪', queued: '排队中', running: '制作中', processing: '制作中', planned: '分镜就绪', completed: '已完成', succeeded: '已完成', waiting_review: '等待审阅', awaiting_review: '等待审阅', needs_attention: '需要核对', failed: '执行失败', canceled: '已停止', cancelled: '已停止', archived: '回收站', stale: '需更新', pending: '待执行', waiting_external: '等待结果', retry_scheduled: '等待重试' };
export function Status({ value }: { value: string }) { return <span className={`status status--${value}`}><span />{statusLabels[value] ?? value}</span>; }

export function formatTime(us: number) {
  const total = Math.max(0, us / 1_000_000);
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${Math.floor(total % 60).toString().padStart(2, '0')}.${Math.floor((total % 1) * 100).toString().padStart(2, '0')}`;
}
