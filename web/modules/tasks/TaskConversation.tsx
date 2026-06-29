'use client';
import { useMemo, useState } from 'react';
import { Bot, GitCommit, Check, TriangleAlert, User } from 'lucide-react';
import type { CommitLogEntry } from '../../lib/types';
import { useTaskConversation, useTaskCommits, useTaskCommitFileDiff, useTasks, useConfig } from '../../lib/queries';
import { taskExec } from '../../lib/agentUtils';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { useTranslation } from '../../lib/i18n';
import { formatTaskTime, parseTs } from '../../lib/format';
import { fileIcon } from '../../lib/fileIcon';
import { baseName, dirName } from '../../lib/filePath';
import { Modal } from '../../components/ui/Modal';
import { PatchView } from '../projects/editor/PatchView';

/** The JSON payload an autopilot `decision` event carries in its `detail` column. */
interface DecisionPayload { kind: 'prompt' | 'choice'; question: string; outcome: 'approved' | 'escalated' | 'chose'; rationale: string; confidence: number; optionLabel?: string }

/** Parse a decision event's detail blob — always in try/catch (it's stored JSON). */
function parseDecision(detail: string): DecisionPayload | null {
  try {
    const p = JSON.parse(detail) as Partial<DecisionPayload>;
    if (p && typeof p.outcome === 'string' && typeof p.question === 'string') return p as DecisionPayload;
  } catch { /* malformed — skip this row, keep the feed */ }
  return null;
}

/** The JSON payload a `message` event carries: one free-text turn in the worker↔autopilot conversation. */
type MessageRole = 'agent' | 'autopilot' | 'human';
interface MessagePayload { role: MessageRole; text: string }

/** Parse a message event's detail blob — always in try/catch (it's stored JSON). */
function parseMessage(detail: string): MessagePayload | null {
  try {
    const p = JSON.parse(detail) as Partial<MessagePayload>;
    if (p && typeof p.text === 'string' && (p.role === 'agent' || p.role === 'autopilot' || p.role === 'human')) return p as MessagePayload;
  } catch { /* malformed — skip this row, keep the feed */ }
  return null;
}

type FeedItem =
  | { kind: 'decision'; ts: number; key: string; payload: DecisionPayload }
  | { kind: 'review'; ts: number; key: string; approved: boolean; rationale: string }
  | { kind: 'message'; ts: number; key: string; payload: MessagePayload }
  | { kind: 'commit'; ts: number; key: string; commit: CommitLogEntry };

/** Message role → avatar. The agent and the autopilot each show the brand icon of the model that is
 *  actually running them (worker exec / overseer exec) so the thread reads as a back-and-forth between
 *  the two models; a human reply shows a person. Falls back to a generic chip when the model is unknown. */
function MessageAvatar({ role, workerExec, overseerExec }: { role: MessageRole; workerExec: string; overseerExec: string }) {
  if (role === 'human') return <User size={14} className="shrink-0 text-text-muted" aria-hidden />;
  const exec = role === 'agent' ? workerExec : overseerExec;
  if (!exec) return <Bot size={14} className="shrink-0 text-text-muted" aria-hidden />;
  return <ModelIcon name={exec} size={14} />;
}

/** Outcome → colored icon + class. Decisions and the post-done review share the same approve/escalate
 *  visual vocabulary so the feed reads consistently. */
function outcomeTone(outcome: DecisionPayload['outcome']): { Icon: typeof Check; cls: string } {
  if (outcome === 'escalated') return { Icon: TriangleAlert, cls: 'text-warning' };
  return { Icon: Check, cls: 'text-success' }; // approved / chose
}

/** A task's autopilot conversation merged with its live git history, oldest-first: what the agent asked,
 *  what the autopilot decided (and why), and the commits the agent landed — all on one time axis. Both
 *  sources refresh live via SSE (`decision`/`review` → conversation, `change` → commits). */
export function TaskConversation({ task }: { task: { id: string } }) {
  const { t, locale } = useTranslation();
  const conversation = useTaskConversation(task.id);
  const commits = useTaskCommits(task.id);
  // The two models talking: the worker's exec (this task's exec label) and the overseer's configured
  // backend. Used to brand each message turn with the icon of the model that produced it.
  const tasks = useTasks();
  const config = useConfig();
  const workerExec = taskExec(tasks.data?.find((x) => x.id === task.id)?.labels);
  const overseerExec = config.data?.autopilot.overseerExec ?? '';
  // Track which commit's file is open so the modal shows THAT commit's diff (git show), not the
  // cumulative base..head diff — the feed is per-commit history.
  const [openFile, setOpenFile] = useState<{ hash: string; path: string } | null>(null);
  const fileDiff = useTaskCommitFileDiff(task.id, openFile?.hash ?? null, openFile?.path ?? null);

  const items = useMemo<FeedItem[]>(() => {
    const out: FeedItem[] = [];
    for (const e of conversation.data ?? []) {
      // `e.ts` is SQLite `datetime('now')` — a bare UTC string with no zone. parseTs tags it `Z` so it
      // isn't misread as local time (a non-UTC host would skew it hours off the git-epoch commit times).
      const ts = parseTs(e.ts) ?? 0;
      if (e.type === 'decision') {
        const payload = parseDecision(e.detail);
        if (payload) out.push({ kind: 'decision', ts, key: `d${e.id}`, payload });
      } else if (e.type === 'review') {
        // Detail is `"<approved|escalated>: <rationale>"` (eventStore.toRow).
        const approved = e.detail.startsWith('approved');
        out.push({ kind: 'review', ts, key: `r${e.id}`, approved, rationale: e.detail.replace(/^[^:]*:\s*/, '') });
      } else if (e.type === 'message') {
        const payload = parseMessage(e.detail);
        if (payload) out.push({ kind: 'message', ts, key: `m${e.id}`, payload });
      }
    }
    for (const c of commits.data?.commits ?? []) out.push({ kind: 'commit', ts: c.timestamp, key: `c${c.hash}`, commit: c });
    return out.sort((a, b) => a.ts - b.ts);
  }, [conversation.data, commits.data]);

  if (items.length === 0) return null;

  const outcomeLabel = (o: DecisionPayload['outcome']) =>
    o === 'approved' ? t.tasks.decisionApproved : o === 'chose' ? t.tasks.decisionChose : t.tasks.decisionEscalated;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t.tasks.activityLog}</span>
      <ul className="flex flex-col gap-1.5">
        {items.map((it) => {
          const when = formatTaskTime(new Date(it.ts).toISOString(), Date.now(), locale);
          if (it.kind === 'commit') {
            const c = it.commit;
            const added = c.files.reduce((s, f) => s + f.added, 0);
            const deleted = c.files.reduce((s, f) => s + f.deleted, 0);
            return (
              <li key={it.key} className="rounded-lg border border-border bg-surface p-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <GitCommit size={14} className="shrink-0 text-text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-text" title={c.subject}>{c.subject}</span>
                  <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
                    <span className="text-success">+{added}</span><span className="text-danger">−{deleted}</span>
                  </span>
                  {when.label ? <span className="shrink-0 text-text-muted" title={when.title}>{when.label}</span> : null}
                </div>
                {c.files.length > 0 ? (
                  <ul className="mt-1.5 flex flex-col gap-0.5 pl-6">
                    {c.files.map((f) => {
                      const Icon = fileIcon(f.path);
                      return (
                        <li key={f.path}>
                          <button type="button" onClick={() => setOpenFile({ hash: c.hash, path: f.path })} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-elevated">
                            <Icon size={13} className="shrink-0 text-text-muted" aria-hidden />
                            <span className="min-w-0 flex-1 truncate" title={f.path}>
                              <span className="text-text-muted">{dirName(f.path)}</span><span className="text-text">{baseName(f.path)}</span>
                            </span>
                            <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
                              <span className="text-success">+{f.added}</span><span className="text-danger">−{f.deleted}</span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          }
          if (it.kind === 'message') {
            const roleLabel = it.payload.role === 'agent' ? t.tasks.msgRoleAgent : it.payload.role === 'human' ? t.tasks.msgRoleHuman : t.tasks.msgRoleAutopilot;
            return (
              <li key={it.key} className="rounded-lg border border-border bg-surface p-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <MessageAvatar role={it.payload.role} workerExec={workerExec} overseerExec={overseerExec} />
                  <span className="min-w-0 flex-1 truncate font-medium text-text">{roleLabel}</span>
                  {when.label ? <span className="shrink-0 text-text-muted" title={when.title}>{when.label}</span> : null}
                </div>
                <p className="mt-1 whitespace-pre-wrap pl-6 text-text-muted">{it.payload.text}</p>
              </li>
            );
          }
          // decision / review — same approve/escalate visual vocabulary
          const tone = it.kind === 'decision' ? outcomeTone(it.payload.outcome) : outcomeTone(it.approved ? 'approved' : 'escalated');
          const question = it.kind === 'decision' ? it.payload.question : t.tasks.reviewVerdict;
          const rationale = it.kind === 'decision' ? it.payload.rationale : it.rationale;
          const label = it.kind === 'decision' ? outcomeLabel(it.payload.outcome) : (it.approved ? t.tasks.decisionApproved : t.tasks.decisionEscalated);
          return (
            <li key={it.key} className="rounded-lg border border-border bg-surface p-2.5 text-xs">
              <div className="flex items-center gap-2">
                <Bot size={14} className="shrink-0 text-text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium text-text" title={question}>{question}</span>
                <span className={`inline-flex shrink-0 items-center gap-1 font-medium ${tone.cls}`}><tone.Icon size={12} aria-hidden />{label}</span>
                {it.kind === 'decision' ? <span className="shrink-0 font-mono text-[10px] text-text-muted">{Math.round(it.payload.confidence * 100)} %</span> : null}
                {when.label ? <span className="shrink-0 text-text-muted" title={when.title}>{when.label}</span> : null}
              </div>
              {it.kind === 'decision' && it.payload.optionLabel ? <p className="mt-1 pl-6 text-text">{it.payload.optionLabel}</p> : null}
              {rationale ? <p className="mt-1 whitespace-pre-wrap pl-6 text-text-muted">{rationale}</p> : null}
            </li>
          );
        })}
      </ul>

      {openFile ? (
        <Modal title={baseName(openFile.path)} description={openFile.path} icon={fileIcon(openFile.path)} size="lg" onClose={() => setOpenFile(null)}>
          <div className="flex h-full min-h-0 flex-col p-5">
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
              <PatchView diff={fileDiff.data?.diff ?? ''} empty={fileDiff.isLoading ? t.common.loading : t.projects.noChanges} />
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
