'use client';

import { useEffect, useState } from 'react';
import { Target } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { formatDuration, parseTs } from '../../lib/format';
import type { BrainGoal } from '../../lib/types';

export function goalSubgoalTally(raw: string): { done: number; total: number } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const done = parsed.filter((entry) =>
      typeof entry === 'object' && entry !== null && (entry as { done?: unknown }).done === true).length;
    return { done, total: parsed.length };
  } catch {
    return null;
  }
}

export function useGoalElapsed(goal: BrainGoal | null): number {
  const startedAt = parseTs(goal?.created_at) ?? Date.now();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!goal) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [goal]);
  return goal ? Math.max(0, now - startedAt) : 0;
}

/** The CLI-style active-goal chip for chat surfaces that do not currently have a visible telemetry rail. */
export function GoalStatusInline({ goal }: { goal: BrainGoal }) {
  const { t } = useTranslation();
  const elapsed = useGoalElapsed(goal);
  const turns = goal.turn_budget > 0 ? `${goal.turns_used}/${goal.turn_budget}` : String(goal.turns_used);
  const detail = goal.last_evidence ? `${goal.goal} — ${goal.last_evidence}` : goal.goal;
  return (
    <div
      data-testid="chat-goal-status"
      className="flex min-w-0 items-center gap-1.5 text-primary"
      aria-label={`${t.telemetry.goal}: ${turns}, ${formatDuration(elapsed)}, ${detail}`}
    >
      <Target size={11} className="shrink-0" aria-hidden />
      <span className="shrink-0 font-medium">{t.telemetry.goal}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{turns} · {formatDuration(elapsed)}</span>
      <span className="text-muted-foreground" aria-hidden>·</span>
      <span className="min-w-0 truncate text-foreground" title={detail}>{goal.goal}</span>
    </div>
  );
}
