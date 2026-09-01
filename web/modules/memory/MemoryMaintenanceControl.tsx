'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Tags, Wrench } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { apiErrorMessage } from '../../lib/elowenClient';
import { interpolate, useTranslation } from '../../lib/i18n';
import { useStartMemoryRecategorize, useStartMemoryReindex } from '../../lib/mutations';
import { QUERY_KEYS, useCategorizationSettings, useEmbeddingSettings, useMemoryCategories, useMemoryMaintenance } from '../../lib/queries';
import type { MemoryMaintenanceJob, MemoryMaintenanceState, MemoryRecategorizeMode } from '../../lib/types';

export function MemoryMaintenanceControl() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const maintenance = useMemoryMaintenance();
  const embedding = useEmbeddingSettings();
  const categorization = useCategorizationSettings();
  const categories = useMemoryCategories();
  const reindex = useStartMemoryReindex();
  const recategorize = useStartMemoryRecategorize();
  const watched = useRef(new Map<string, 'reindex' | 'recategorize'>());
  const previous = useRef<MemoryMaintenanceState | null>(null);

  useEffect(() => {
    const state = maintenance.data;
    if (!state) return;
    for (const job of [state.reindex, state.recategorize]) {
      if (!job) continue;
      const prior = previous.current?.[job.operation];
      const landed = job.id && job.status !== 'running' && job.status !== 'idle'
        && (prior?.id !== job.id || prior.status === 'running');
      if (landed) {
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.memories });
        if (job.operation === 'recategorize') {
          void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.memoryCategories });
        } else {
          void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.embeddingSettings });
        }
      }
      if (!job.id || !watched.current.has(job.id) || job.status === 'running') continue;
      watched.current.delete(job.id);
      if (job.status === 'done') {
        toast(interpolate(t.memory.maintenanceCompleted, {
          succeeded: job.succeeded,
          failed: job.failed,
        }));
      } else if (job.status === 'error') {
        toast(job.error || t.memory.maintenanceFailed, 'error');
      }
    }
    previous.current = state;
  }, [maintenance.data, queryClient, t.memory.maintenanceCompleted, t.memory.maintenanceFailed, toast]);

  const watch = (job: MemoryMaintenanceJob) => {
    if (job.id) watched.current.set(job.id, job.operation);
    toast(t.memory.maintenanceStarted);
  };

  const startReindex = () => {
    reindex.mutate(undefined, {
      onSuccess: watch,
      onError: (error) => toast(apiErrorMessage(error), 'error'),
    });
  };

  const startRecategorize = (mode: MemoryRecategorizeMode) => {
    recategorize.mutate(mode, {
      onSuccess: watch,
      onError: (error) => toast(apiErrorMessage(error), 'error'),
    });
  };

  const state = maintenance.data;
  const noCategories = categories.data !== undefined && categories.data.length === 0;
  const running = state?.reindex?.status === 'running' || state?.recategorize?.status === 'running';

  return (
    <>
      <Button variant="ghost" icon={Wrench} onClick={() => setOpen(true)}>
        {t.memory.maintenanceTitle}
        {running ? <span className="ml-1 h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden /> : null}
      </Button>

      {open ? (
        <Modal title={t.memory.maintenanceTitle} description={t.memory.maintenanceIntro} icon={Wrench} size="md" onClose={() => setOpen(false)}>
          <ModalBody>
            <div className="flex flex-col gap-3">
              <MaintenanceRow
                job={state?.reindex}
                title={t.memory.maintenanceReindex}
                description={embedding.data?.configured ? t.memory.maintenanceReindexHint : t.memory.reindexUnconfigured}
                actionLabel={t.memory.maintenanceReindex}
                disabled={!embedding.data?.configured || reindex.isPending || state?.reindex?.status === 'running'}
                onAction={startReindex}
                icon={RefreshCw}
              />
              <MaintenanceRow
                job={state?.recategorize}
                title={t.memory.maintenanceRecategorize}
                description={!categorization.data?.configured
                  ? t.memory.maintenanceCategorizationUnconfigured
                  : noCategories ? t.memory.categoriesEmpty : t.memory.maintenanceRecategorizeHint}
                actionLabel={t.memory.maintenanceUncategorized}
                disabled={!categorization.data?.configured || noCategories || recategorize.isPending || state?.recategorize?.status === 'running'}
                onAction={() => startRecategorize('uncategorized')}
                secondaryLabel={t.memory.maintenanceAll}
                onSecondary={() => setConfirmAll(true)}
                secondaryDisabled={!categorization.data?.configured || noCategories || recategorize.isPending || state?.recategorize?.status === 'running'}
                icon={Tags}
              />
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t.common.close}</Button>
          </ModalFooter>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={confirmAll}
        title={t.memory.maintenanceAllConfirmTitle}
        description={t.memory.maintenanceAllConfirmBody}
        confirmLabel={t.memory.maintenanceAll}
        confirmVariant="accent"
        onConfirm={() => { setConfirmAll(false); startRecategorize('all'); }}
        onClose={() => setConfirmAll(false)}
      />
    </>
  );
}

function MaintenanceRow({
  job,
  title,
  description,
  actionLabel,
  disabled,
  onAction,
  secondaryLabel,
  onSecondary,
  secondaryDisabled,
  icon: Icon,
}: {
  job?: MemoryMaintenanceJob;
  title: string;
  description: string;
  actionLabel: string;
  disabled: boolean;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  secondaryDisabled?: boolean;
  icon: typeof Wrench;
}) {
  const { t } = useTranslation();
  const progress = job?.status === 'running' && job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><Icon size={15} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
          {job && job.status !== 'idle' ? (
            <div className="mt-3" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <span>{maintenanceStatus(job, t.memory)}</span>
                <span className="font-mono tabular-nums">{job.processed}/{job.total}</span>
              </div>
              {job.status === 'running' ? (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.processed}>
                  <span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
                </div>
              ) : null}
              {job.failed > 0 ? <p className="mt-1 text-[11px] text-warning">{interpolate(t.memory.maintenanceFailures, { n: job.failed })}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {secondaryLabel && onSecondary ? <Button variant="ghost" size="sm" disabled={secondaryDisabled} onClick={onSecondary}>{secondaryLabel}</Button> : null}
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onAction}>{actionLabel}</Button>
      </div>
    </section>
  );
}

function maintenanceStatus(job: MemoryMaintenanceJob, copy: ReturnType<typeof useTranslation>['t']['memory']): string {
  if (job.status === 'running') return copy.maintenanceRunning;
  if (job.status === 'done') return copy.maintenanceDone;
  if (job.status === 'error') return copy.maintenanceError;
  return copy.maintenanceIdle;
}
