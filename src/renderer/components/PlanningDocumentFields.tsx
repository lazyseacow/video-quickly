import { formatPlanningDocument, planningDocumentSchemas, type ManualPlanningFields, type PlanningDocumentKind } from '@video-quickly/contracts';
import { planningLabels } from '../lib/planning-edits';
import { Field } from './Primitives';
import './planning-document-fields.css';

export function initialPlanningDocument(kind: PlanningDocumentKind, stored: ManualPlanningFields[PlanningDocumentKind], text: string, title = '') {
  if (stored && formatPlanningDocument(kind, stored) === text) return stored;
  const defaults: Record<string, string> = kind === 'brief' ? { topic: title, coreMessage: text } : { artStyle: text };
  return Object.fromEntries(Object.keys(planningDocumentSchemas[kind].shape).map(key => [key, defaults[key] ?? '']));
}

export default function PlanningDocumentFields({ kind, value, onChange }: {
  kind: PlanningDocumentKind; value: Readonly<Record<string, string>>; onChange(key: string, value: string): void;
}) {
  return <fieldset className="planning-document-fields">
    <legend>{planningLabels[kind]}</legend>
    {Object.entries(planningDocumentSchemas[kind].shape).map(([key, schema]) => {
      const metadata = schema.meta();
      const rows = typeof metadata?.rows === 'number' ? metadata.rows : 1;
      const required = Boolean(schema.minLength);
      const props = {
        'data-planning-field': `${kind}-${key}`,
        value: value[key] ?? '', required, maxLength: schema.maxLength ?? undefined,
        placeholder: typeof metadata?.placeholder === 'string' ? metadata.placeholder : undefined,
      };
      return <Field key={key} label={metadata?.title ?? key} required={required}>
        {rows > 1 ? <textarea {...props} rows={rows} onChange={event => onChange(key, event.target.value)} />
          : <input {...props} onChange={event => onChange(key, event.target.value)} />}
      </Field>;
    })}
  </fieldset>;
}
