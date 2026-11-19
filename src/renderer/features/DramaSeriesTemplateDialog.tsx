import { useState } from 'react';
import { recordPageSchema, seriesTemplateSchema, type SeriesTemplate } from '@video-quickly/contracts';
import { Button, Dialog, Field, Notice, Select } from '../components/Primitives';
import { useRecordPage } from '../lib/use-record-page';

const templatePage = recordPageSchema(seriesTemplateSchema);

export default function DramaSeriesTemplateDialog({ current, version, onChoose, onClose }: {
  current?: SeriesTemplate;
  version: number;
  onChoose(template: SeriesTemplate | undefined): void;
  onClose(): void;
}) {
  const [selectedId, setSelectedId] = useState(current?.id ?? '');
  const library = useRecordPage('seriesTemplate.list', { archived: false, limit: 20 }, version, templatePage);
  const templates = library.items;
  const currentOutsidePage = current && !templates.some(item => item.id === current.id) ? current : undefined;
  const selected = templates.find(item => item.id === selectedId) ?? (currentOutsidePage?.id === selectedId ? currentOutsidePage : undefined);
  return <Dialog title="选择系列模板" onClose={onClose}>
    <div className="dialog__body form-stack">
      <Field label="系列模板">{field => <Select {...field} value={selectedId} onChange={event => setSelectedId(event.target.value)}>
        <option value="">不使用模板</option>
        {currentOutsidePage && <option value={currentOutsidePage.id}>{currentOutsidePage.name}</option>}
        {templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </Select>}</Field>
      {selected?.description && <p>{selected.description}</p>}
      {library.error && <Notice kind="error">{library.error}<Button onClick={library.refresh}>重试</Button></Notice>}
      {!library.hasLoaded && !library.error && <p role="status">正在读取模板…</p>}
      {library.nextCursor !== null && <Button disabled={!library.canLoadMore} busy={library.loadingMore} onClick={() => void library.loadMore()}>加载更多模板</Button>}
    </div>
    <div className="dialog__footer">
      <Button onClick={onClose}>取消</Button>
      <Button variant="primary" disabled={Boolean(selectedId && !selected)} onClick={() => onChoose(selected)}>应用选择</Button>
    </div>
  </Dialog>;
}
