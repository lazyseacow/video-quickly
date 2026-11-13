import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { chargeActionRequestSchema, chargeConfirmationSchema, isChargeAction, type ChargeEstimate, type VideoReferenceReview } from '@video-quickly/contracts';
import { getAssetUrl, rpc } from '../lib/client';
import { Button, Dialog } from './Primitives';
import './confirmation-dialog.css';

interface ConfirmationOptions {
  title: string;
  description: string;
  confirmLabel: string;
  variant?: 'danger' | 'primary';
  estimate?: ChargeEstimate;
  videoReferences?: VideoReferenceReview;
}
type Confirm = (options: ConfirmationOptions) => Promise<boolean>;
interface PendingConfirmation extends ConfirmationOptions { resolve: (confirmed: boolean) => void; }
const ConfirmationContext = createContext<Confirm | undefined>(undefined);

const countFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
const currencyFormats = {
  CNY: new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 6 }),
  USD: new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }),
};
function formatCharge({ currency, amount }: NonNullable<ChargeEstimate['totals']>[number]) {
  const format = currencyFormats[currency];
  return amount > 0 && amount < 0.000001 ? `小于 ${format.format(0.000001)}` : format.format(amount);
}
function generationQuantity(item: ChargeEstimate['items'][number]) {
  const units = { text: '项文本任务', image: '张图片', video: '段视频' };
  if (item.count === undefined) return `${{ text: '文本', image: '图片', video: '视频' }[item.kind]}生成量待确定`;
  const count = `${countFormat.format(item.count)} ${units[item.kind]}`;
  return item.videoSeconds === undefined ? count : `${count} · 共 ${countFormat.format(item.videoSeconds)} 秒`;
}

export function ChargeEstimateDetails({ estimate }: { estimate: ChargeEstimate }) {
  const { batch, items, totals } = estimate;
  return <section className="charge-estimate" aria-label="生成与费用预估">
    <h3>模型与生成量</h3>
    {items.length ? <ul className="charge-estimate__models">{items.map((item, index) => <li key={index}>
      <div className="charge-estimate__model">
        <strong>{item.modelName ?? '模型待确定'}</strong>
        {item.model && item.model !== item.modelName && <small>{item.model}</small>}
        <span>{generationQuantity(item)}</span>
      </div>
      {(items.length > 1 || !totals) && item.estimated && <span className="charge-estimate__amount">{formatCharge(item.estimated)}</span>}
    </li>)}</ul> : <p className="charge-estimate__hint">模型与生成量待确定。</p>}
    <dl className="charge-estimate__total">
      <dt>{batch ? '预估总费用' : '预计费用'}</dt>
      <dd>{totals?.map(formatCharge).join(' · ') ?? '暂无法估算'}</dd>
    </dl>
    <p className="charge-estimate__hint">{totals ? '按模型连接中配置的单价估算，以服务商实际计费为准。' : '当前费用无法完整估算，以服务商实际计费为准。'}</p>
  </section>;
}

function ReferenceThumbnail({ path }: { path: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    void getAssetUrl(path).then(value => { if (active) setUrl(value); }, () => { if (active) setUrl(undefined); });
    return () => { active = false; };
  }, [path]);
  return url ? <img alt="" src={url} loading="lazy" onError={() => setUrl(undefined)} /> : null;
}

function VideoReferenceDetails({ review }: { review: VideoReferenceReview }) {
  return <section className="video-reference-review" aria-label="视频参考图">
    <h3>视频参考图</h3>
    {review.status === 'pending' ? <p className="charge-estimate__hint">{review.until === 'storyboard' ? '生成分镜后确定参考图。' : review.until === 'previous-video' ? '上一镜完成后提取尾帧作为下一镜参考图。' : '素材准备完成后确定参考图。'}</p> : <>
      <ul className="video-reference-review__shots">{review.shots.map(shot => <li key={shot.id}>
        <strong>{shot.title}</strong> <small>{shot.mode === 'single' ? '单图输入' : '多图参考'}</small>
        <ul className="video-reference-review__images">{shot.images.map(file => <li key={file.id}><ReferenceThumbnail path={file.path} /><span>{file.name}</span></li>)}</ul>
      </li>)}</ul>
      {review.textShots > 0 && <p className="charge-estimate__hint">{review.textShots} 个镜头使用文字生成。</p>}
    </>}
  </section>;
}

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
  return <ConfirmationContext.Provider value={confirm}>{children}{request && <Dialog role="alertdialog" title={request.title} descriptionId={descriptionId} initialFocus={cancel} className={`confirmation-dialog${request.estimate ? ' confirmation-dialog--estimate' : ''}`} onClose={() => settle(false)}>
    <div className="dialog__body"><p id={descriptionId}>{request.description}</p>{request.estimate && <ChargeEstimateDetails estimate={request.estimate} />}{request.videoReferences && <VideoReferenceDetails review={request.videoReferences} />}</div>
    <div className="dialog__footer"><Button ref={cancel} onClick={() => settle(false)}>取消</Button><Button variant={request.variant ?? 'danger'} onClick={() => settle(true)}>{request.confirmLabel}</Button></div>
  </Dialog>}</ConfirmationContext.Provider>;
}

export function useConfirmation() {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error('确认操作需要位于 ConfirmationProvider 中。');
  return confirm;
}

export function useChargeRpc() {
  const confirm = useConfirmation();
  return useCallback(async <T = unknown,>(method: string, params: unknown = {}, onSubmit?: () => void): Promise<T | null> => {
    let payload = params;
    if (isChargeAction(method)) {
      const request = chargeActionRequestSchema.parse({ method, params });
      const prepared = chargeConfirmationSchema.nullable().parse(await rpc('billing.prepare', request));
      if (prepared) {
        const { confirmationId, ...prompt } = prepared;
        if (!await confirm({ ...prompt, variant: 'primary' })) {
          // An abandoned confirmation also expires in the runtime if the connection closes.
          void rpc('billing.cancel', { chargeConfirmationId: confirmationId }).catch(() => undefined);
          return null;
        }
        payload = { ...request.params, chargeConfirmationId: confirmationId };
      }
    }
    onSubmit?.();
    return rpc<T>(method, payload);
  }, [confirm]);
}
