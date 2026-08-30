'use client';

import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { Button } from './Button';
import { Input } from './Input';
import { interpolate, useTranslation } from '../../lib/i18n';

export interface TokenListProps {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  onBrowse?: () => void;
}

export const normalizeTokenList = (tokens: string[]): string[] => [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];

const braceDepthAt = (text: string, end: number): number => {
  let depth = 0;
  for (let index = 0; index < end; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}' && depth > 0) depth -= 1;
  }
  return depth;
};

/** Free-form token editor for paths, globs and similar open vocabularies. */
export function TokenList({ label, value, onChange, placeholder, onBrowse }: TokenListProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const composing = useRef(false);

  const commit = (tokens: string[]) => {
    if (tokens.some((token) => token.trim())) onChange(normalizeTokenList([...value, ...tokens]));
    setDraft('');
  };
  const remove = (index: number) => onChange(normalizeTokenList(value.filter((_, itemIndex) => itemIndex !== index)));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || event.nativeEvent.isComposing || (event as KeyboardEvent<HTMLInputElement> & { isComposing?: boolean }).isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commit([draft]);
      return;
    }
    if (event.key !== ',') return;
    const caret = event.currentTarget.selectionStart ?? draft.length;
    // A comma is a delimiter only outside an unfinished brace expression. This keeps common globs such as
    // `src/**/*.{ts,tsx}` intact; a literal comma elsewhere can always arrive through ordinary paste.
    if (braceDepthAt(draft, caret) > 0) return;
    event.preventDefault();
    commit([draft]);
  };
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (composing.current
      || (event.nativeEvent as Event & { isComposing?: boolean }).isComposing
      || (event as ClipboardEvent<HTMLInputElement> & { isComposing?: boolean }).isComposing) return;
    const text = event.clipboardData.getData('text');
    if (!/[\r\n]/.test(text)) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? draft.length;
    const end = input.selectionEnd ?? start;
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    lines[0] = `${draft.slice(0, start)}${lines[0] ?? ''}`;
    lines[lines.length - 1] = `${lines.at(-1) ?? ''}${draft.slice(end)}`;
    commit(lines);
  };

  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-2">
      {value.length > 0 ? (
        <ul aria-label={interpolate(t.pluginCfg.tokenListItems, { label })} className="flex flex-wrap gap-1.5">
          {value.map((token, index) => (
            <li key={`${token}-${index}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">
              <span className="truncate" title={token}>{token}</span>
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label={interpolate(t.pluginCfg.tokenListRemove, { value: token })}
                className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs italic text-muted-foreground">{t.pluginCfg.tokenListEmpty}</p>}
      <div className="flex min-w-0 items-center gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => { if (draft.trim()) commit([draft]); }}
          aria-label={interpolate(t.pluginCfg.tokenListAdd, { label })}
          placeholder={placeholder ?? t.pluginCfg.tokenListPlaceholder}
        />
        {onBrowse ? (
          <Button type="button" variant="outline" size="sm" icon={FolderOpen} onClick={onBrowse}>
            {t.pluginCfg.tokenListBrowse}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
