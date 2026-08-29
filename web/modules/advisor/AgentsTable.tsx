'use client';
import { useEffect, useRef, useState } from 'react';
import { Users, ChevronRight } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { formatTokens } from '../../lib/format';
import type { SubagentState } from '../../lib/transcript';

const STATUS_DOT: Record<SubagentState['status'], string> = {
  running: 'text-success',
  done: 'text-muted-foreground',
  error: 'text-destructive',
};

/** The workflow view: a table of the delegated sub-agents (model · tokens · tools · idle · status). Rows
 *  drill into a child's transcript. Mirrors the CLI's agents panel, in the web design. */
export function AgentsTable({ agents, onOpen, onClose }: { agents: SubagentState[]; onOpen: (sessionId: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  // Idle = seconds since a RUNNING agent last changed its counters. Stamp the time whenever an agent's
  // signature changes; a 1s ticker re-renders so the number climbs while it sits quiet.
  const seen = useRef<Map<string, { sig: string; at: number }>>(new Map());
  const [, tick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    for (const a of agents) {
      const sig = `${a.tools}|${a.tokens ?? ''}|${a.detail ?? ''}|${a.status}`;
      const prev = seen.current.get(a.sessionId);
      if (!prev || prev.sig !== sig) seen.current.set(a.sessionId, { sig, at: now });
    }
  }, [agents]);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, []);

  const now = Date.now();
  const idleOf = (a: SubagentState): number | null => {
    if (a.status !== 'running') return null;
    const prev = seen.current.get(a.sessionId);
    return prev ? Math.round((now - prev.at) / 1000) : 0;
  };

  return (
    <Modal title={t.agents.title} description={t.agents.subtitle} onClose={onClose} size="xl" icon={Users}>
      <ModalBody>
        {/* The container query that drops the secondary columns measures the room the TABLE actually has,
            which is the body's content box — so it rides a wrapper inside the body, not the scroll region
            the shell owns. */}
        <div className="@container">
          <table className="w-full text-tiny">
            {/* A sticky head has to be opaque or the rows read through it, and the ground it floats over is
                the dialog's own `--color-popover`. `bg-card` was a second, darker surface painted at the
                call site: a #070707 strip over a #151515 panel. */}
            <thead className="sticky top-0 bg-popover text-muted-foreground">
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2 font-medium">{t.agents.task}</th>
                <th className="agents-table-secondary px-3 py-2 font-medium">{t.agents.model}</th>
                <th className="agents-table-secondary px-3 py-2 text-right font-medium">{t.agents.tokens}</th>
                <th className="agents-table-secondary px-3 py-2 text-right font-medium">{t.agents.tools}</th>
                <th className="agents-table-secondary px-3 py-2 text-right font-medium">{t.agents.idle}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const idle = idleOf(a);
                return (
                  <tr
                    key={a.sessionId}
                    onClick={() => onOpen(a.sessionId)}
                    className="cursor-pointer border-b border-border/50 transition-colors hover:bg-accent"
                  >
                    <td className="max-w-0 px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className={`shrink-0 ${STATUS_DOT[a.status]}`} title={t.agents[a.status]}>●</span>
                        <span className="truncate text-foreground" title={a.task}>{a.detail || a.task}</span>
                      </div>
                    </td>
                    <td className="agents-table-secondary whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">{a.model ?? '—'}</td>
                    <td className="agents-table-secondary px-3 py-2 text-right tabular-nums text-muted-foreground">{a.tokens != null ? formatTokens(a.tokens) : '—'}</td>
                    <td className="agents-table-secondary px-3 py-2 text-right tabular-nums text-muted-foreground">{a.tools}</td>
                    <td className="agents-table-secondary px-3 py-2 text-right tabular-nums text-muted-foreground">{idle == null ? '—' : `${idle}s`}</td>
                    <td className="px-2 py-2 text-right"><ChevronRight size={13} className="text-muted-foreground" aria-hidden /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ModalBody>
    </Modal>
  );
}
