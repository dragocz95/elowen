'use client';
import { Circle, CircleDot, CheckCircle2, ListChecks } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { formatDuration } from '../../lib/format';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/ActionMenu';
import { Spinner } from '../../components/ui/states';
import type { RailTask } from '../../lib/railTasks';
import { BlockedTip } from './BlockedTip';

/** The DOM test ids a host stamps on its rows. The transcript card and the telemetry rail render the
 *  same row, and each of their test suites addresses it by its own names. */
export interface TodoRowIds {
  /** The row itself (the `li`). */
  row: string;
  /** The turning spinner wrapped in a span on the in-progress row. */
  running: string;
  /** The live `· 12m 3s` clock on the in-progress row. */
  elapsed: string;
  /** The blocked tooltip riding beside the trigger. */
  blocked: string;
}

/** One task row of the conversation's checklist, shared by its two homes: the transcript's todo card
 *  (`TodoCard` in BrainChatSurface) and the telemetry rail's Tasks section. The two hosts differ in the
 *  box they put it in and the test ids they assert on — nothing else.
 *
 *  The glyph-and-text line is the whole control: a click opens a small menu with the three statuses and
 *  the way into the full list. Deliberately no tick box: a box invites a stray click to finish a task,
 *  and every change here reaches the agent's plan. A menu makes the move explicit, and it opens on click
 *  only — the row is in the reading path, and a panel that opened when the pointer merely crossed it
 *  would interrupt the reader on every pass over the card.
 *
 *  `BlockedTip` is a button of its own and rides beside the trigger, never inside it. */
export function TodoRow({ row, now, onStatus, onOpen, ids }: {
  row: RailTask;
  now: number;
  onStatus: (row: RailTask, status: RailTask['status']) => void;
  onOpen: () => void;
  ids: TodoRowIds;
}) {
  const { t } = useTranslation();
  const blocked = row.status === 'pending' && row.blockedBy.length > 0;
  const elapsed = row.status === 'in_progress' && Number.isFinite(row.startedAt)
    ? formatDuration(now - row.startedAt!)
    : null;
  const actions: ActionMenuItem[] = [
    { label: t.tasksModal.statusPending, icon: Circle, onSelect: () => onStatus(row, 'pending') },
    { label: t.tasksModal.statusInProgress, icon: CircleDot, onSelect: () => onStatus(row, 'in_progress') },
    { label: t.tasksModal.statusCompleted, icon: CheckCircle2, onSelect: () => onStatus(row, 'completed') },
    { label: t.telemetry.tasksOpen, icon: ListChecks, onSelect: onOpen },
  ];
  return (
    <li data-testid={ids.row} className="flex min-w-0 items-center gap-1">
      <ActionMenu
        items={actions}
        label={`${t.tasksModal.taskActions}: ${row.label}${row.owner ? ` · ${row.owner}` : ''}`}
        align="left"
        openOnHover={false}
        // Only the row's own padding: the rows sit on each other with no fixed height, like the card.
        triggerClassName="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent"
        trigger={
          <>
            {/* The same vocabulary the tool rows use: a turning spinner for the task being worked on,
                a ticked circle for a finished one, an empty circle for one still waiting. */}
            {row.status === 'in_progress' ? (
              <span data-testid={ids.running} className="flex shrink-0"><Spinner size="xs" tone="text-primary" /></span>
            ) : row.status === 'completed' ? (
              <CheckCircle2 size={11} aria-hidden className="shrink-0 text-success" />
            ) : (
              <Circle size={11} aria-hidden className="shrink-0 text-muted-foreground" />
            )}
            <span className={`min-w-0 truncate ${row.status === 'completed' ? 'text-muted-foreground line-through' : blocked ? 'text-subtle-foreground' : 'text-foreground'}`}>
              {row.label}
            </span>
            {elapsed ? (
              <span data-testid={ids.elapsed} className="shrink-0 tabular-nums text-primary">· {elapsed}</span>
            ) : null}
            {row.owner ? (
              <span className="shrink-0 text-muted-foreground opacity-70">· {row.owner}</span>
            ) : null}
          </>
        }
      />
      {blocked ? <BlockedTip ids={row.blockedBy} testId={ids.blocked} /> : null}
    </li>
  );
}