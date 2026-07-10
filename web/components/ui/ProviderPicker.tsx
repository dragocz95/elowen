'use client';
import { Segmented } from './Segmented';

/** Pick one of the configured brain providers as the credential + endpoint source, so an API key is
 *  entered once (on the provider) and reused everywhere — never typed twice. This is the single
 *  provider-selection control shared by Memory (embedding/categorization), plugin `provider` fields and
 *  Autopilot; callers pass an already-filtered list (e.g. key-set only, or non-OAuth for embeddings).
 *  A stale saved id (its provider since removed) stays selectable as its own option so a selection is
 *  never silently lost. */
export function ProviderPicker({ providers, value, onChange, label, emptyText, size = 'md', variant = 'default' }: {
  providers: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  /** Shown when no provider qualifies (e.g. none has a key set). */
  emptyText?: string;
  size?: 'sm' | 'md';
  variant?: 'default' | 'line';
}) {
  const options = providers.map((p) => ({ value: p.id, label: p.label }));
  if (value && !providers.some((p) => p.id === value)) options.unshift({ value, label: value });
  if (options.length === 0) return <p className="text-xs italic text-text-muted">{emptyText ?? ''}</p>;
  return <Segmented aria-label={label} options={options} value={value} onChange={onChange} size={size} variant={variant} />;
}
