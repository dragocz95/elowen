'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { uiZoom } from '../../lib/uiZoom';
import Link from 'next/link';
import { Bell, ShieldAlert } from 'lucide-react';
import type { Task } from '../../lib/types';
import { useSessions, useSessionSignals, useTasks, useEscalations, usePendingAsks } from '../../lib/queries';
import { needsInputSessions, taskSessionName } from '../../lib/agentUtils';
import { taskExec } from '../../lib/agentUtils';
import { NeedsInputRow } from './NeedsInputRow';
import { useTranslation } from '../../lib/i18n';

/** Sidebar notification bell: a count of agents waiting for human approval, with a dropdown
 *  listing each one and inline Allow/Reject. The dropdown is portalled to <body> and positioned
 *  from the button's rect so it escapes the sidebar's overflow / mobile-drawer transform. */
export function NotificationBell() {
  const { t } = useTranslation();
  const sessions = useSessions();
  const signals = useSessionSignals();
  const tasks = useTasks();

  const waiting = needsInputSessions(sessions.data ?? [], signals);
  const escalations = useEscalations();
  const pendingAsks = usePendingAsks().data ?? [];
  const inboxCount = escalations.length + pendingAsks.length;
  const count = waiting.length + inboxCount;
  const inboxPreview = pendingAsks[0]?.title?.trim()
    || pendingAsks[0]?.question?.trim()
    || escalations[0]?.title;

  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const place = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Portalled into <body>, inside the UI-scale `zoom`. getBoundingClientRect returns zoomed (visual)
    // coords, so divide by z before using them as fixed CSS positions. The bell now lives in the top bar,
    // so the menu opens DOWNWARD (top = button bottom) and is right-aligned to the button (w-80 = 320px)
    // so it never spills off the right edge.
    const z = uiZoom();
    setPos({ left: Math.max(8, r.right / z - 320), top: r.bottom / z + 8 });
  };
  const toggle = () => { if (!open) place(); setOpen((o) => !o); };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const reposition = () => place();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', reposition); };
  }, [open]);

  const taskFor = (name: string): Task | undefined => (tasks.data ?? []).find((x) => taskSessionName(x) === name);

  return (
    <div className="shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-label={t.sidebar.notifications}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t.sidebar.notifications}
        className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-elevated ${count > 0 ? 'text-warning' : 'text-text-muted hover:text-text'}`}
      >
        <Bell size={18} aria-hidden />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-0.5 text-[9px] font-bold text-black">{count}</span>
        )}
      </button>

      {mounted && open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            aria-label={t.sidebar.notifications}
            className="fixed z-[61] w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border bg-surface"
            style={{ left: pos.left, top: pos.top, boxShadow: 'var(--shadow-raised)' }}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold text-text">
              <Bell size={13} className={count > 0 ? 'text-warning' : 'text-text-muted'} aria-hidden />
              {t.sidebar.notifications}
              {count > 0 && <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-warning/15 px-1 text-[10px] font-bold text-warning">{count}</span>}
            </div>
            {count === 0 ? (
              <div className="px-3 py-7 text-center text-xs text-text-muted">{t.sidebar.noNotifications}</div>
            ) : (
              <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-auto p-2">
                {/* Human decisions share one inbox: overseer escalations and parked agent asks. */}
                {inboxCount > 0 && (
                  <Link
                    href="/escalations"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/[0.06] px-2.5 py-2 transition-colors hover:bg-warning/10"
                  >
                    <ShieldAlert size={14} className="shrink-0 text-warning" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium text-text">{t.sidebar.escalations.replace('{count}', String(inboxCount))}</span>
                      {inboxPreview ? <span className="block truncate text-tiny text-text-muted">{inboxPreview}</span> : null}
                    </span>
                  </Link>
                )}
                {waiting.map((name) => {
                  const signal = signals[name];
                  return <NeedsInputRow key={name} name={name} question={signal?.type === 'needs_input' ? signal.question : ''} options={signal?.type === 'needs_input' ? signal.options : undefined} exec={taskExec(taskFor(name)?.labels)} />;
                })}
              </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
