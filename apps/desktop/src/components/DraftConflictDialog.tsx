import { useState } from 'react';
import { mergeEdits, type EditContent } from '../lib/project-edits';
import { Button, Dialog, Notice } from './Primitives';

function display(value: unknown) {
  if (value === undefined) return '已移除';
  return typeof value === 'string' ? value || '（空）' : JSON.stringify(value, null, 2);
}

export default function DraftConflictDialog({ base, local, remote, onClose, onResolve, onDiscard }: {
  base: EditContent; local: EditContent; remote: EditContent; onClose: () => void;
  onResolve: (choices: Record<string, 'local' | 'remote'>) => void; onDiscard: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, 'local' | 'remote'>>({});
  const { conflicts } = mergeEdits(base, local, remote, choices);
  return <Dialog title="比较草稿与已保存内容" onClose={onClose} className="dialog--wide">
    <div className="dialog__body"><Notice>{conflicts.length ? '双方修改了以下相同内容。逐项选择要保留的版本，其他改动会自动合并。' : '双方修改没有重叠，合并后将保留双方的修改。'}</Notice>
      {conflicts.map(conflict => <fieldset className="draft-conflict" key={conflict.path}><legend>{conflict.label}</legend><div className="draft-conflict__versions">{(['local', 'remote'] as const).map(side => <label key={side}><span><input type="radio" aria-label={side === 'local' ? '我的草稿' : '已保存内容'} name={conflict.path} checked={(choices[conflict.path] ?? 'local') === side} onChange={() => setChoices(current => ({ ...current, [conflict.path]: side }))} />{side === 'local' ? '我的草稿' : '已保存内容'}</span><pre>{display(conflict[side])}</pre></label>)}</div></fieldset>)}
    </div><div className="dialog__footer"><Button onClick={onDiscard}>放弃草稿并重新载入</Button><Button onClick={onClose}>稍后处理</Button><Button variant="primary" onClick={() => onResolve(choices)}>合并所选内容</Button></div>
  </Dialog>;
}
