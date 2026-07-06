'use client';
import { useState } from 'react';
import { Wrench, Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useUserTools } from '../../lib/queries';
import { useUpdateUser } from '../../lib/mutations';
import { useToast } from '../../components/ui/Toast';
import { MorePill } from '../../components/ui/MorePill';
import { useTranslation } from '../../lib/i18n';
import type { UserToolPill, UserToolState } from '../../lib/types';

const VISIBLE = 12; // pills shown before the "+ N more" control

/** Tone per access state — allowed reads normal, inherited is muted, disabled/unavailable are faded. */
const stateClass: Record<UserToolState, string> = {
  allowed: 'border-border bg-elevated text-text',
  inherited: 'border-border bg-surface text-text-muted',
  disabled: 'border-border/60 bg-surface text-text-muted/60 line-through',
  unavailable: 'border-border/60 bg-surface text-text-muted/60 line-through',
};

function Icon({ tool }: { tool: UserToolPill }) {
  return <span aria-hidden className="shrink-0 text-[13px] leading-none">{tool.icon ?? <Wrench size={12} className="inline" />}</span>;
}

/** The user's effective tool access as compact pills: allowed first (server-sorted), each with its
 *  plugin/built-in icon (fallback glyph otherwise). Plugin tools are clickable to enable/disable them
 *  for THIS user's own brain sessions (built-ins are fixed). Collapses past VISIBLE with a keyboard-
 *  operable "+ N more" toggle. */
export function ToolPills({ userId }: { userId: number }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const tools = useUserTools(userId);
  const update = useUpdateUser();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');

  const all = tools.data ?? [];
  if (tools.isLoading) return <p className="text-xs text-text-muted">…</p>;
  if (all.length === 0) return <p className="text-xs italic text-text-muted">{t.users.toolsEmpty}</p>;

  // Filter by name/label/plugin; a search collapses the "+ N more" limit so matches aren't hidden.
  const q = query.trim().toLowerCase();
  const data = q ? all.filter((x) => x.name.toLowerCase().includes(q) || x.label.toLowerCase().includes(q) || (x.plugin ?? '').toLowerCase().includes(q)) : all;

  const stateLabel = (s: UserToolState) =>
    s === 'allowed' ? t.users.stateAllowed
    : s === 'inherited' ? t.users.stateInherited
    : s === 'disabled' ? t.users.stateDisabled : t.users.stateUnavailable;

  // Toggle a plugin tool in the user's deny-list. The current deny-set is exactly the toggleable tools
  // reported `disabled`; send the whole next set (the PATCH replaces it), then refetch so pills restyle.
  const toggle = (tool: UserToolPill) => {
    // Compute the deny-set from the FULL list (not the search-filtered view) so a search can't drop names.
    const current = new Set(all.filter((x) => x.toggleable && x.state === 'disabled').map((x) => x.name));
    if (current.has(tool.name)) current.delete(tool.name); else current.add(tool.name);
    update.mutate({ id: userId, patch: { disabled_tools: [...current] } }, {
      // Silent on success (the pill restyles) — only surface a toast when it fails.
      onSuccess: () => qc.invalidateQueries({ queryKey: ['user-tools', userId] }),
      onError: (e) => toast(String(e) || t.users.updateError, 'error'),
    });
  };

  const shown = (expanded || q) ? data : data.slice(0, VISIBLE);
  const pillClass = (tool: UserToolPill) =>
    `inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] ${stateClass[tool.state]}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative max-w-xs">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.users.searchTools}
          aria-label={t.users.searchTools}
          className="w-full rounded-md border border-border bg-surface py-1.5 pl-8 pr-2.5 text-xs text-text outline-none transition-colors focus:border-accent"
        />
      </div>
      {data.length === 0
        ? <p className="text-xs italic text-text-muted">{t.users.toolsNoMatch}</p>
        : <ul className="flex flex-wrap gap-1.5">
        {shown.map((tool) => tool.toggleable ? (
          <li key={tool.name}>
            <button
              type="button"
              onClick={() => toggle(tool)}
              disabled={update.isPending}
              aria-pressed={tool.state !== 'disabled'}
              title={`${tool.label}${tool.plugin ? ` · ${tool.plugin}` : ''} · ${stateLabel(tool.state)}`}
              className={`${pillClass(tool)} cursor-pointer transition-colors hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60`}
            >
              <Icon tool={tool} /><span className="truncate">{tool.name}</span>
            </button>
          </li>
        ) : (
          <li key={tool.name} className={pillClass(tool)} title={`${tool.label} · ${stateLabel(tool.state)}`}>
            <Icon tool={tool} /><span className="truncate">{tool.name}</span>
            <span className="sr-only">{`, ${stateLabel(tool.state)}`}</span>
          </li>
        ))}
      </ul>}
      {!q && data.length > VISIBLE && (
        <MorePill expanded={expanded} hidden={data.length - VISIBLE} onToggle={() => setExpanded((v) => !v)} />
      )}
    </div>
  );
}
