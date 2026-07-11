'use client';
import { useState } from 'react';
import { ShieldAlert, ShieldCheck, Rocket, Play, RotateCcw, Link2, Clock, MessagesSquare, GitBranch, Inbox } from 'lucide-react';
import type { Escalation } from '../../lib/escalations';
import type { PendingAsk } from '../../lib/types';
import { useEscalations, usePendingAsks } from '../../lib/queries';
import { useSetTaskStatus, useResumeMission, useApproveGate, useReplyAsk } from '../../lib/mutations';
import { apiErrorMessage } from '../../lib/elowenClient';
import { formatTaskTime } from '../../lib/format';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { WorkspaceHeader, WorkspaceMetric, WorkspaceMetrics, WorkspacePage } from '../../components/ui/WorkspacePrimitives';

/** One worker question parked on a human: shows the question and a reply box that unblocks the agent
 *  (POST /tasks/:id/ask/:askId/reply). Distinct from a review escalation — there's no gate to release,
 *  just a free-text answer the agent is blocking on. */
function PendingAskCard({ ask }: { ask: PendingAsk }) {
  const { t, locale } = useTranslation();
  const reply = useReplyAsk();
  const { toast } = useToast();
  const [text, setText] = useState('');
  const when = ask.since ? formatTaskTime(new Date(ask.since).toISOString(), Date.now(), locale) : { label: '', title: '' };
  const send = () => {
    const v = text.trim();
    if (!v) return;
    reply.mutate({ taskId: ask.taskId, askId: ask.askId, text: v }, {
      onSuccess: () => { toast(t.escalations.askReplied); setText(''); },
      onError: (e) => toast(apiErrorMessage(e) || t.escalations.askReplyError, 'error'),
    });
  };
  return (
    <article className="escalation-register-row flex flex-col gap-4 border-t border-accent/30 px-1 py-5 sm:px-3">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/10">
          <MessagesSquare size={20} className="text-accent" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-text">{t.escalations.askTitle}{ask.title ? ` · ${ask.title}` : ''}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-text-muted">
            {ask.epicId ? <><Rocket size={11} className="shrink-0" aria-hidden /><span className="truncate">{ask.epicId}</span></> : null}
            {when.label ? <><span aria-hidden className="opacity-50">·</span><Clock size={11} className="shrink-0" aria-hidden /><span title={when.title}>{when.label}</span></> : null}
          </div>
        </div>
      </div>
      <div className="border-l border-accent/35 py-1 pl-4">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-text">{ask.question}</p>
      </div>
      <p className="text-xs text-text-muted">{t.escalations.askDesc}</p>
      <div className="flex items-center gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} placeholder={t.escalations.askReplyPlaceholder} className="flex-1" />
        <Button variant="accent" icon={Play} onClick={send} disabled={!text.trim() || reply.isPending}>{t.escalations.askSend}</Button>
      </div>
    </article>
  );
}

/** Escalations inbox: every overseer rejection still awaiting a human, with the full rationale (which
 *  used to be crammed into a toast) and the two resolutions — accept the result and let the mission
 *  continue, or re-run the rejected phase. Items self-clear once their gated phases are released. */
export function EscalationsView() {
  const { t, locale } = useTranslation();
  const escalations = useEscalations();
  const pendingAsks = usePendingAsks().data ?? [];
  const setStatus = useSetTaskStatus();
  const approveGate = useApproveGate();
  const resume = useResumeMission();
  const { toast } = useToast();
  const blockedCount = escalations.reduce((sum, escalation) => sum + escalation.blocked.length, 0);
  const total = escalations.length + pendingAsks.length;

  // Accept the rejection: ask the daemon to release this phase's review gate. It re-opens only the
  // dependents no OTHER predecessor still gates (a DAG dependent can be held by several phases), so a
  // downstream phase never starts while another of its predecessors is still unresolved. Then nudge
  // the mission so the engine picks the released phases up now instead of waiting out the 90s tick.
  const approve = (e: Escalation) => {
    if (e.blocked.length === 0) return;
    approveGate.mutate(e.taskId, {
      onSuccess: () => {
        if (e.epicId) resume.mutate(`m-${e.epicId}`, { onError: () => { /* mission may be idle — released phases still get picked up on a later tick */ } });
        toast(t.escalations.approved);
      },
      onError: (err) => toast(apiErrorMessage(err) || t.escalations.actionError, 'error'),
    });
  };
  // Re-run the rejected phase itself: re-open it so the engine re-spawns its agent.
  const rerun = (e: Escalation) => {
    setStatus.mutate({ id: e.taskId, status: 'open' }, {
      onSuccess: () => {
        if (e.epicId) resume.mutate(`m-${e.epicId}`, { onError: () => { /* idle mission — a later tick re-spawns it */ } });
        toast(t.escalations.rerunning);
      },
      onError: (err) => toast(apiErrorMessage(err) || t.escalations.actionError, 'error'),
    });
  };

  return (
    <>
      <ModuleHeader title={t.escalations.title} count={escalations.length + pendingAsks.length} icon={ShieldAlert} />
      <WorkspacePage>
        <WorkspaceHeader
          eyebrow={t.escalations.workspaceEyebrow}
          title={t.escalations.title}
          count={total}
          description={t.escalations.workspaceIntro}
          icon={ShieldAlert}
          status={<span className="workspace-status">{total > 0 ? t.escalations.workspaceWaiting : t.escalations.workspaceReady}</span>}
        />
        <WorkspaceMetrics visual={<div className="escalations-core"><Inbox size={28} strokeWidth={1.25} /></div>} ariaLabel={t.escalations.summary}>
          <WorkspaceMetric label={t.escalations.metricTotal} value={total} icon={Inbox} />
          <WorkspaceMetric label={t.escalations.metricQuestions} value={pendingAsks.length} icon={MessagesSquare} />
          <WorkspaceMetric label={t.escalations.metricReviews} value={escalations.length} icon={ShieldAlert} />
          <WorkspaceMetric label={t.escalations.metricBlocked} value={blockedCount} icon={GitBranch} />
        </WorkspaceMetrics>

      {total === 0 ? (
        <div className="workspace-content"><EmptyState title={t.escalations.empty} description={t.escalations.emptyDesc} icon={ShieldCheck} /></div>
      ) : (
        <div className="workspace-content">
          {/* Agent questions waiting on a human come first — an agent is actively blocked on each. */}
          {pendingAsks.length > 0 ? <h2 className="border-b border-border/80 px-1 pb-3 font-mono text-[10px] font-semibold uppercase tracking-[.14em] text-accent sm:px-3">{t.escalations.questionsSection}</h2> : null}
          {pendingAsks.map((a) => <PendingAskCard key={a.askId} ask={a} />)}
          {escalations.length > 0 ? <h2 className="border-b border-border/80 px-1 pb-3 pt-7 font-mono text-[10px] font-semibold uppercase tracking-[.14em] text-warning sm:px-3">{t.escalations.reviewsSection}</h2> : null}
          {escalations.map((e) => {
            const when = formatTaskTime(e.ts, Date.now(), locale);
            return (
              <article key={`${e.taskId}-${e.ts}`} className="escalation-register-row flex flex-col gap-4 border-t border-warning/30 px-1 py-5 sm:px-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-warning/40 bg-warning/10">
                    <ShieldAlert size={20} className="text-warning" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold text-text">{e.title}</h2>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-text-muted">
                      {e.epicId ? <><Rocket size={11} className="shrink-0" aria-hidden /><span className="truncate">{e.epicId}</span></> : null}
                      {when.label ? <><span aria-hidden className="opacity-50">·</span><Clock size={11} className="shrink-0" aria-hidden /><span title={when.title}>{when.label}</span></> : null}
                    </div>
                  </div>
                </div>

                {/* The overseer's verdict — the long text that used to be a toast, now readable. */}
                <div className="border-l border-warning/35 py-1 pl-4">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t.escalations.rationale}</div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-text">{e.rationale || t.escalations.noReason}</p>
                </div>

                {e.blocked.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t.escalations.blockedBy}</span>
                    <ul className="flex flex-col gap-1">
                      {e.blocked.map((b) => (
                        <li key={b.id} className="flex items-center gap-2 text-xs text-text">
                          <Link2 size={12} className="shrink-0 text-text-muted" aria-hidden />
                          <span className="min-w-0 flex-1 truncate">{b.title}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button type="button" onClick={() => rerun(e)} disabled={setStatus.isPending} className="inline-flex items-center gap-1.5 px-1 py-2 text-xs text-text-muted transition-colors hover:text-warning disabled:opacity-40"><RotateCcw size={13} aria-hidden />{t.escalations.rerun}</button>
                  <Button variant="accent" icon={Play} onClick={() => approve(e)} disabled={e.blocked.length === 0 || approveGate.isPending}>{t.escalations.approve}</Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      </WorkspacePage>
    </>
  );
}
