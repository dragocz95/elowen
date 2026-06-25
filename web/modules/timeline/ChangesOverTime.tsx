'use client';
import { useMemo, useState } from 'react';
import { GitCommit, Plus, Minus } from 'lucide-react';
import type { CommitLogEntry } from '../../lib/types';
import { useProjectCommit, useProjectCommitFileDiff } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { fileIcon } from '../../lib/fileIcon';
import { baseName, dirName } from '../../lib/filePath';
import { Badge } from '../../components/ui/Badge';
import { ProjectPill } from '../../components/ui/ProjectPill';
import { Modal } from '../../components/ui/Modal';
import { PatchView } from '../projects/editor/PatchView';

export type TimelineCommit = CommitLogEntry & { projectId: number };

const hhmm = (ts: number) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const sumAdded = (c: TimelineCommit) => c.files.reduce((n, f) => n + f.added, 0);
const sumDeleted = (c: TimelineCommit) => c.files.reduce((n, f) => n + f.deleted, 0);

/** The distinct file-type icons in a commit, each with how many files of that type changed —
 *  a compact "what kind of files moved" glance for a commit row. */
function typeBreakdown(files: { path: string }[]): { Icon: ReturnType<typeof fileIcon>; key: string; count: number }[] {
  const by = new Map<string, { Icon: ReturnType<typeof fileIcon>; count: number }>();
  for (const f of files) {
    const Icon = fileIcon(f.path);
    const key = Icon.displayName ?? Icon.name ?? f.path;
    const e = by.get(key);
    if (e) e.count++; else by.set(key, { Icon, count: 1 });
  }
  return [...by.entries()].map(([key, v]) => ({ key, Icon: v.Icon, count: v.count })).slice(0, 5);
}

/** Tiny activity sparkline: bucket timestamps across the window into bars. */
function Spark({ stamps, start, end }: { stamps: number[]; start: number; end: number }) {
  const BINS = 12;
  const bins = useMemo(() => {
    const b = new Array(BINS).fill(0);
    const span = end - start || 1;
    for (const t of stamps) { const i = Math.min(BINS - 1, Math.max(0, Math.floor(((t - start) / span) * BINS))); b[i]++; }
    return b;
  }, [stamps, start, end]);
  const max = Math.max(1, ...bins);
  return (
    <span className="inline-flex h-4 items-end gap-px" aria-hidden>
      {bins.map((b, i) => <span key={i} className="w-[3px] rounded-sm bg-accent/55" style={{ height: `${b ? Math.max(14, (b / max) * 100) : 6}%`, opacity: b ? 1 : 0.3 }} />)}
    </span>
  );
}

function CommitRow({ c, multiProject, onOpen }: { c: TimelineCommit; multiProject: boolean; onOpen: (c: TimelineCommit) => void }) {
  const added = sumAdded(c);
  const deleted = sumDeleted(c);
  return (
    <button
      type="button"
      onClick={() => onOpen(c)}
      className="card-interactive group flex w-full flex-col gap-1.5 rounded-lg border border-border bg-surface p-2.5 text-left"
    >
      <div className="flex flex-wrap items-center gap-2">
        <GitCommit size={13} className="shrink-0 text-text-muted group-hover:text-accent" aria-hidden />
        <span className="font-mono text-[11px] text-text-muted">{hhmm(c.timestamp)}</span>
        <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-text-muted">{c.hash}</span>
        {multiProject ? <ProjectPill projectId={c.projectId} /> : null}
        <span className="ml-auto inline-flex items-center gap-2 font-mono text-[11px]">
          {added ? <span className="inline-flex items-center text-success"><Plus size={10} aria-hidden />{added}</span> : null}
          {deleted ? <span className="inline-flex items-center text-danger"><Minus size={10} aria-hidden />{deleted}</span> : null}
        </span>
      </div>
      <div className="truncate text-sm text-text">{c.subject}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {typeBreakdown(c.files).map(({ key, Icon, count }) => (
          <span key={key} className="inline-flex items-center gap-1 rounded-md border border-border bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-text-muted">
            <Icon size={12} className="shrink-0" aria-hidden />{count}
          </span>
        ))}
        <span className="font-mono text-[11px] text-text-muted">{c.files.length === 1 ? baseName(c.files[0].path) : `${c.files.length}`}</span>
      </div>
    </button>
  );
}

/** "Changes over time" — the commit stream below the axis plus a roll-up of the most-touched files
 *  in the window. Each commit opens its full diff; files show how often and how heavily they moved. */
export function ChangesOverTime({ commits, windowStart, now, multiProject }: { commits: TimelineCommit[]; windowStart: number; now: number; multiProject: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<TimelineCommit | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; hash: string; projectId: number } | null>(null);
  const detail = useProjectCommit(open ? open.projectId : null, open ? open.hash : null);
  const fileDiff = useProjectCommitFileDiff(openFile ? openFile.projectId : null, openFile ? openFile.hash : null, openFile ? openFile.path : null);

  const topFiles = useMemo(() => {
    // commits arrive newest-first, so the first commit that touches a file is its latest change —
    // remember that commit's hash/project so clicking the file can show that diff.
    const by = new Map<string, { path: string; count: number; added: number; deleted: number; stamps: number[]; hash: string; projectId: number }>();
    for (const c of commits) {
      for (const f of c.files) {
        const e = by.get(f.path) ?? { path: f.path, count: 0, added: 0, deleted: 0, stamps: [], hash: c.hash, projectId: c.projectId };
        e.count++; e.added += f.added; e.deleted += f.deleted; e.stamps.push(c.timestamp);
        by.set(f.path, e);
      }
    }
    return [...by.values()].sort((a, b) => b.count - a.count || (b.added + b.deleted) - (a.added + a.deleted)).slice(0, 8);
  }, [commits]);

  if (!commits.length) {
    return (
      <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted">{t.timeline.noChangesInWindow}</div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      {/* commit stream */}
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">{t.timeline.changesOverTime}</h3>
        <div className="flex flex-col gap-2">
          {commits.map((c) => <CommitRow key={`${c.projectId}-${c.hash}`} c={c} multiProject={multiProject} onOpen={setOpen} />)}
        </div>
      </section>

      {/* most active files */}
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">{t.timeline.mostActiveFiles}</h3>
        <div className="flex flex-col gap-1.5">
          {topFiles.map((f) => {
            const Icon = fileIcon(f.path);
            return (
              <button
                key={f.path}
                type="button"
                onClick={() => setOpenFile({ path: f.path, hash: f.hash, projectId: f.projectId })}
                className="card-interactive flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface p-2.5 text-left"
              >
                <Icon size={15} className="shrink-0 text-text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm" title={f.path}>
                  <span className="text-text-muted">{dirName(f.path)}</span><span className="text-text">{baseName(f.path)}</span>
                </span>
                <Spark stamps={f.stamps} start={windowStart} end={now} />
                <Badge tone="muted">{f.count}×</Badge>
                <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
                  <span className="text-success">+{f.added}</span><span className="text-danger">−{f.deleted}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {open ? (
        <Modal title={open.subject} description={`${open.hash} · ${hhmm(open.timestamp)}`} icon={GitCommit} size="lg" onClose={() => setOpen(null)}>
          <div className="flex h-full min-h-0 flex-col p-5">
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
              <PatchView diff={detail.data?.diff ?? ''} empty={detail.isLoading ? t.common.loading : t.projects.noChanges} />
            </div>
          </div>
        </Modal>
      ) : null}

      {openFile ? (
        <Modal title={baseName(openFile.path)} description={`${openFile.path} · ${openFile.hash}`} icon={fileIcon(openFile.path)} size="lg" onClose={() => setOpenFile(null)}>
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
