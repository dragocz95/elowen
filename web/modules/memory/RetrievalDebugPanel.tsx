'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Sparkles, TriangleAlert, Check, Info } from 'lucide-react';
import type { RetrievalResult, RetrievalScore } from '../../lib/types';
import { elowenClient, apiErrorMessage } from '../../lib/elowenClient';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { useTranslation } from '../../lib/i18n';
import { pct01 } from './memoryMeta';
import { ControlSurfaceRegister, ControlSurfaceToolbar } from '../../components/ui/ControlSurface';

/** Retrieval inspector: run a query through the real recall pipeline and show every candidate's score
 *  breakdown (semantic / importance / recency / usage) and whether it was picked — the "why did the
 *  assistant remember this" view. POST because retrieve() marks candidates used. */
export function RetrievalDebugPanel() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const qc = useQueryClient();
  // retrieve() marks candidates used (bumps use_count / last_used_at), so refresh the list, the touched
  // details and their usage events to reflect the new counters.
  const run = useMutation<RetrievalResult, unknown, string>({
    mutationFn: (q: string) => elowenClient.retrievalDebug(q),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['memories'] });
      void qc.invalidateQueries({ queryKey: ['memory-events'] });
      const touched = new Set<number>([...data.memories.map((m) => m.id), ...data.debug.scores.map((s) => s.id)]);
      for (const id of touched) void qc.invalidateQueries({ queryKey: ['memory', id] });
    },
  });
  const result = run.data;

  const bodyById = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of result?.memories ?? []) map.set(m.id, m.body);
    return map;
  }, [result]);

  const submit = () => { const q = query.trim(); if (q) run.mutate(q); };

  return (
    <div className="flex flex-col">
      <ControlSurfaceToolbar promote={false}>
        <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-text">{t.memory.retrievalHeading}</h2>
        <p className="text-xs text-text-muted">{t.memory.retrievalIntro}</p>
        </div>
      </ControlSurfaceToolbar>

      <ControlSurfaceRegister className="flex flex-col gap-4">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="relative min-w-0 flex-1">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.memory.retrievalQueryPlaceholder} className="pl-9" />
        </div>
        <Button type="submit" variant="accent" icon={Sparkles} disabled={!query.trim() || run.isPending}>{t.memory.retrievalRun}</Button>
      </form>

      {run.isError ? <p className="text-sm text-danger">{apiErrorMessage(run.error)}</p> : null}

      {result ? (
        <div className="flex flex-col gap-3">
          {/* Meta row: fallback note or provider/model + candidate count. `fallback` means "keyword path
              answered", which has two very different causes: embeddings genuinely unavailable (no provider),
              or embeddings that ran and simply cleared nothing above the floor. Only the first warrants the
              "unconfigured" warning — the second is a normal empty-semantic result and gets a neutral note,
              so a configured user is never told their embeddings are off. */}
          {result.debug.fallback ? (
            result.debug.provider ? (
              <p className="inline-flex items-center gap-2 rounded-md border border-border bg-elevated px-3 py-2 text-xs text-text-muted">
                <Info size={13} aria-hidden />{t.memory.retrievalKeywordOnly}
              </p>
            ) : (
              <p className="inline-flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                <TriangleAlert size={13} aria-hidden />{t.memory.retrievalFallback}
              </p>
            )
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {result.debug.provider ? <Badge>{t.memory.retrievalProvider}: {result.debug.provider}</Badge> : null}
            {result.debug.model ? <Badge>{t.memory.retrievalModel}: {result.debug.model}</Badge> : null}
            <Badge tone="muted">{t.memory.retrievalInjected.replace('{n}', String(result.debug.scores.filter((s) => s.picked).length))}</Badge>
          </div>

          {(() => {
            // Show ONLY what the agent actually receives — the injected (picked) memories, not the
            // full sub-threshold candidate breakdown. Every injected memory is in `memories`, so its
            // body always resolves (no bare `#id` rows).
            const injected = result.debug.scores.filter((s) => s.picked).sort((a, b) => b.score - a.score);
            return injected.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-text-muted">{t.memory.retrievalEmpty}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {injected.map((s) => (
                  <ScoreRow key={s.id} score={s} body={bodyById.get(s.id) ?? `#${s.id}`} t={t} />
                ))}
              </ul>
            );
          })()}
        </div>
      ) : null}
      </ControlSurfaceRegister>
    </div>
  );
}

function ScoreRow({ score, body, t }: { score: RetrievalScore; body: string; t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <li className={`rounded-lg border p-3 text-xs ${score.picked ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface'}`}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-text">{body}</p>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-mono text-sm font-semibold tabular-nums text-text">{score.score.toFixed(3)}</span>
          {score.picked ? <span className="inline-flex items-center gap-1 text-[10px] font-medium text-accent"><Check size={11} aria-hidden />{t.memory.scorePicked}</span> : null}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 @sm:grid-cols-4">
        <Weight label={t.memory.scoreSemantic} value={score.semantic} />
        <Weight label={t.memory.scoreImportance} value={score.importanceWeight} />
        <Weight label={t.memory.scoreRecency} value={score.recencyWeight} />
        <Weight label={t.memory.scoreUsage} value={score.usageWeight} />
      </div>
    </li>
  );
}

/** One 0..1 sub-score as a labelled mini-bar. */
function Weight({ label, value }: { label: string; value: number }) {
  const width = Math.max(0, Math.min(100, pct01(value)));
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wide text-text-muted">
        <span>{label}</span><span className="font-mono text-text">{value.toFixed(2)}</span>
      </span>
      <span className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${width}%` }} />
      </span>
    </div>
  );
}
