'use client';
import { useEffect, useState } from 'react';
import { GitBranch, Users } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable, DataTableCell, DataTableChevronCell, DataTableRow } from '../../components/ui/DataTable';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { formatDuration, formatTaskTime, formatTokens, parseTs } from '../../lib/format';
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

/** A wide, horizontally scrollable register of delegated sub-agents. The shared ModalBody owns both axes. */
export function AgentsTable({ agents, onOpen, onClose }: { agents: SubagentState[]; onOpen: (sessionId: string) => void; onClose: () => void }) {
  const { locale, t } = useTranslation();
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
      </ModalBody>
    </Modal>
  );
}
