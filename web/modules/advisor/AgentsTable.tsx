'use client';
import { useEffect, useState } from 'react';
import { ChevronRight, GitBranch, Users } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DataTable, DataTableCell, DataTableChevronCell, DataTableRow } from '../../components/ui/DataTable';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { formatDuration, formatTaskTime, formatTokens, parseTs } from '../../lib/format';
import { useMobileViewport } from '../../lib/useMobile';
import type { SubagentState } from '../../lib/transcript';

const COLUMNS = '5.5rem minmax(16rem,1.8fr) 9rem 5.5rem 4.5rem 6rem 8.5rem 8.5rem 8rem 1.25rem';

const STATUS_TONE = {
  running: 'accent',
  done: 'success',
  error: 'danger',
} as const;

function runDuration(agent: SubagentState, now: number): string {
  if (agent.status !== 'running') return formatDuration(agent.seconds * 1000);
  const startedAt = parseTs(agent.startedAt);
  return formatDuration(startedAt == null ? agent.seconds * 1000 : now - startedAt);
}

function AgentMobileCard({ agent, now, onOpen }: { agent: SubagentState; now: number; onOpen: (sessionId: string) => void }) {
  const { locale, t } = useTranslation();
  const started = formatTaskTime(agent.startedAt, now, locale);
  const updated = formatTaskTime(agent.updatedAt, now, locale);
  const deliveryMethod = agent.autoDeliver
    ? t.agents.deliveryAutomatic
    : agent.background
      ? t.agents.deliveryManual
      : t.agents.deliveryInline;
  const deliveryState = agent.resultDelivery === 'acknowledged'
    ? t.agents.deliveryAcknowledged
    : agent.resultDelivery === 'pending'
      ? t.agents.deliveryPending
      : undefined;

  return (
    <li
      className="group relative min-w-0 overflow-hidden rounded-xl border border-border/80 bg-card/55 shadow-sm transition-colors hover:border-primary/35"
      data-agent-session={agent.sessionId}
    >
      <Button
        type="button"
        variant="ghost"
        aria-label={`${t.agents.openTranscript}: ${agent.task}`}
        onClick={() => onOpen(agent.sessionId)}
        className="absolute inset-0 z-10 h-full w-full rounded-xl p-0 hover:bg-primary/[0.035] focus-visible:ring-2 focus-visible:ring-primary/70"
      />
      <div className="pointer-events-none relative z-20 p-3">
        <div className="flex items-start justify-between gap-2">
          <Badge tone={STATUS_TONE[agent.status]}>{t.agents[agent.status]}</Badge>
          <ChevronRight size={15} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground/65 transition-colors group-hover:text-foreground" />
        </div>

        <div className="mt-3">
          <div className="flex items-start gap-1.5">
            {agent.workspaceId ? (
              <span className="mt-0.5 shrink-0" title={t.agents.sandboxed}>
                <GitBranch size={12} className="text-muted-foreground" aria-hidden />
              </span>
            ) : null}
            <h3 className="min-w-0 break-words text-sm font-semibold leading-snug text-foreground">{agent.task}</h3>
          </div>
          <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{agent.detail ?? '—'}</p>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-lg border border-border/60 bg-background/55 px-2.5 py-2">
          {agent.model ? <ModelIcon name={agent.model} size={13} className="mt-0.5 shrink-0" /> : null}
          <div className="min-w-0">
            <div className="break-all font-mono text-[11px] leading-snug text-foreground">{agent.model ?? '—'}</div>
            <div className="mt-1 break-words text-[11px] text-muted-foreground">{agent.thinkingLabel ?? agent.thinkingLevel ?? '—'}</div>
          </div>
        </div>

        <dl className="mt-3 space-y-2 border-t border-border/60 pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{t.agents.runtime}</dt>
            <dd className="text-[11px] tabular-nums text-foreground">{runDuration(agent, now)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{t.agents.tokens}</dt>
            <dd className="text-[11px] tabular-nums text-foreground">{agent.tokens != null ? formatTokens(agent.tokens) : '—'}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{t.agents.tools}</dt>
            <dd className="text-[11px] tabular-nums text-foreground">{agent.tools}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{t.agents.started}</dt>
            <dd className="min-w-0 truncate text-[11px] tabular-nums text-foreground" title={started.title}>{started.label || '—'}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{t.agents.updated}</dt>
            <dd className="min-w-0 truncate text-[11px] tabular-nums text-foreground" title={updated.title}>{updated.label || '—'}</dd>
          </div>
        </dl>

        <div className="mt-3 border-t border-border/60 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          <div className="text-foreground">{agent.background ? t.agents.background : t.agents.foreground}</div>
          <div>{deliveryMethod}</div>
          {deliveryState ? <div>{deliveryState}</div> : null}
        </div>
      </div>
    </li>
  );
}

/** Phone view uses equal-width agent columns that continue horizontally; each agent's fields run vertically. */
export function AgentsTable({ agents, onOpen, onClose }: { agents: SubagentState[]; onOpen: (sessionId: string) => void; onClose: () => void }) {
  const { locale, t } = useTranslation();
  const mobile = useMobileViewport();
  const [now, setNow] = useState(() => Date.now());
  const hasRunning = agents.some((agent) => agent.status === 'running');

  useEffect(() => {
    if (!hasRunning) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasRunning]);

  return (
    <Modal
      title={t.agents.title}
      description={t.agents.subtitle}
      onClose={onClose}
      size="lg"
      intent="inspect"
      drawerWidth="wide"
      icon={Users}
    >
      <ModalBody>
        {mobile === true ? (
          <ul
            aria-label={t.agents.tableAria}
            className="grid w-max grid-flow-col gap-3"
            style={{ gridAutoColumns: '10.5rem' }}
            data-testid="agents-mobile-list"
          >
            {agents.map((agent) => <AgentMobileCard key={agent.sessionId} agent={agent} now={now} onOpen={onOpen} />)}
          </ul>
        ) : (
          <DataTable
            ariaLabel={t.agents.tableAria}
            columns={COLUMNS}
            compactColumns={COLUMNS}
            mobileColumns={COLUMNS}
            className="min-w-[82rem]"
            data-testid="agents-table"
          >
            <DataTableRow header>
              <DataTableCell header lines={1}>{t.agents.status}</DataTableCell>
              <DataTableCell header lines={1}>{t.agents.task}</DataTableCell>
              <DataTableCell header lines={1}>{t.agents.model}</DataTableCell>
              <DataTableCell header lines={1} className="text-right">{t.agents.tokens}</DataTableCell>
              <DataTableCell header lines={1} className="text-right">{t.agents.tools}</DataTableCell>
              <DataTableCell header lines={1} className="text-right">{t.agents.runtime}</DataTableCell>
              <DataTableCell header lines={1}>{t.agents.started}</DataTableCell>
              <DataTableCell header lines={1}>{t.agents.updated}</DataTableCell>
              <DataTableCell header lines={1}>{t.agents.modeDelivery}</DataTableCell>
            </DataTableRow>
            {agents.map((agent) => {
              const started = formatTaskTime(agent.startedAt, now, locale);
              const updated = formatTaskTime(agent.updatedAt, now, locale);
              const deliveryMethod = agent.autoDeliver
                ? t.agents.deliveryAutomatic
                : agent.background
                  ? t.agents.deliveryManual
                  : t.agents.deliveryInline;
              const deliveryState = agent.resultDelivery === 'acknowledged'
                ? t.agents.deliveryAcknowledged
                : agent.resultDelivery === 'pending'
                  ? t.agents.deliveryPending
                  : undefined;
              const deliveryTitle = deliveryState ? `${deliveryMethod} · ${deliveryState}` : deliveryMethod;
              return (
                <DataTableRow
                  key={agent.sessionId}
                  height="tall"
                  className="group cursor-pointer"
                  onOpen={() => onOpen(agent.sessionId)}
                  openLabel={`${t.agents.openTranscript}: ${agent.task}`}
                  data-agent-session={agent.sessionId}
                >
                  <DataTableCell lines="auto">
                    <Badge tone={STATUS_TONE[agent.status]}>{t.agents[agent.status]}</Badge>
                  </DataTableCell>
                  <DataTableCell lines="auto" title={agent.task}>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {agent.workspaceId ? (
                          <span className="shrink-0" title={t.agents.sandboxed}>
                            <GitBranch size={12} className="text-muted-foreground" aria-hidden />
                          </span>
                        ) : null}
                        <span className="truncate font-medium text-foreground">{agent.task}</span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground" title={agent.detail}>{agent.detail ?? '—'}</div>
                    </div>
                  </DataTableCell>
                  <DataTableCell lines="auto">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {agent.model ? <ModelIcon name={agent.model} size={13} className="shrink-0" /> : null}
                        <span className="truncate font-mono text-xs text-foreground" title={agent.model}>{agent.model ?? '—'}</span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground" title={agent.thinkingLabel ?? agent.thinkingLevel}>
                        {agent.thinkingLabel ?? agent.thinkingLevel ?? '—'}
                      </div>
                    </div>
                  </DataTableCell>
                  <DataTableCell lines={1} className="text-right tabular-nums text-muted-foreground">
                    {agent.tokens != null ? formatTokens(agent.tokens) : '—'}
                  </DataTableCell>
                  <DataTableCell lines={1} className="text-right tabular-nums text-muted-foreground">{agent.tools}</DataTableCell>
                  <DataTableCell lines={1} className="text-right tabular-nums text-muted-foreground">{runDuration(agent, now)}</DataTableCell>
                  <DataTableCell lines={1} title={started.title} className="tabular-nums text-muted-foreground">{started.label || '—'}</DataTableCell>
                  <DataTableCell lines={1} title={updated.title} className="tabular-nums text-muted-foreground">{updated.label || '—'}</DataTableCell>
                  <DataTableCell lines="auto">
                    <div className="min-w-0">
                      <div className="truncate text-foreground">{agent.background ? t.agents.background : t.agents.foreground}</div>
                      <div className="truncate text-xs text-muted-foreground" title={deliveryTitle}>
                        <span>{deliveryMethod}</span>{deliveryState ? <><span aria-hidden> · </span><span>{deliveryState}</span></> : null}
                      </div>
                    </div>
                  </DataTableCell>
                  <DataTableChevronCell />
                </DataTableRow>
              );
            })}
          </DataTable>
        )}
      </ModalBody>
    </Modal>
  );
}
