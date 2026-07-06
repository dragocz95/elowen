'use client';
import { useState } from 'react';
import { MorePill } from './MorePill';
import { Input } from './Input';
import { ModelIcon } from './ModelIcon';
import { useTranslation } from '../../lib/i18n';

/** Clickable model pills over a catalog. Each pill carries its brand icon (ModelIcon matches by name);
 *  the active pill(s) read as accent. Collapsed by default: the first `previewCount` pills show inline
 *  on wrapping rows, and a trailing "+X more" pill expands the rest. A search box appears once the
 *  catalog outgrows the preview and filters the whole catalog case-insensitively (ignoring collapse).
 *
 *  Two selection modes via `mode`:
 *   - 'multi'  → value: string[]; toggles; empty selection means "the whole catalog". Shows a count
 *                footer (all vs {n}), matching the Brain provider picker.
 *   - 'single' → value: string | null; clicking a pill selects it, clicking the active one clears it. */
type CommonProps = {
  catalog: string[];
  /** How many pills show before the "+X more" collapse (default 8). */
  previewCount?: number;
  className?: string;
};
type MultiProps = CommonProps & { mode: 'multi'; value: string[]; onChange: (models: string[]) => void };
type SingleProps = CommonProps & { mode: 'single'; value: string | null; onChange: (model: string | null) => void };
export type ModelPillsPickerProps = MultiProps | SingleProps;

export function ModelPillsPicker(props: ModelPillsPickerProps) {
  const { catalog, previewCount = 8, className } = props;
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);

  const isActive = (m: string) => (props.mode === 'multi' ? props.value.includes(m) : props.value === m);
  const toggle = (m: string) => {
    if (props.mode === 'multi') {
      props.onChange(props.value.includes(m) ? props.value.filter((x) => x !== m) : [...props.value, m]);
    } else {
      props.onChange(props.value === m ? null : m);
    }
  };

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const matches = searching ? catalog.filter((m) => m.toLowerCase().includes(q)) : catalog;
  const hasMore = !searching && matches.length > previewCount;
  const shown = searching || expanded ? matches : matches.slice(0, previewCount);

  return (
    <div className={`flex flex-col gap-2${className ? ` ${className}` : ''}`}>
      {catalog.length > previewCount ? (
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.modelPicker.searchPlaceholder} aria-label={t.modelPicker.searchPlaceholder} />
      ) : null}
      <div className="flex flex-wrap content-start gap-1.5">
        {shown.map((m) => {
          const on = isActive(m);
          return (
            <button key={m} type="button" onClick={() => toggle(m)} aria-pressed={on}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-xs transition-colors ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`}
              style={{ transitionDuration: 'var(--motion-fast)' }}>
              <ModelIcon name={m} size={14} />{m}
            </button>
          );
        })}
        {hasMore ? (
          <MorePill expanded={expanded} hidden={matches.length - previewCount} onToggle={() => setExpanded((v) => !v)} />
        ) : null}
        {shown.length === 0 ? <span className="text-xs italic text-text-muted">{t.modelPicker.noMatch}</span> : null}
      </div>
      {props.mode === 'multi' ? (
        <span className="text-tiny text-text-muted">{props.value.length === 0 ? t.modelPicker.pickAll : t.modelPicker.pickCount.replace('{n}', String(props.value.length))}</span>
      ) : null}
    </div>
  );
}
