'use client';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollText, Trash2 } from 'lucide-react';
import type { OnMount } from '@monaco-editor/react';
import { Modal } from '../../components/ui/Modal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { EmptyState, LoadingState, ErrorState } from '../../components/ui/states';
import { MonacoEditor } from '../../lib/monaco/monacoLoader';
import { defineEditorThemes, editorTheme } from '../../lib/monaco/oledTheme';
import { ElowenApiError } from '../../lib/elowenClient';
import { useLogFiles, useLogFile } from '../../lib/queries';
import { useDeleteLogFile, useDeleteAllLogFiles } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';
import { parseLogLines, filterLogLines, refreshScrollAction, LOG_LEVELS, type LogLevel } from './logFilter';
import { formatBytes } from '../../lib/format';

/** Line count asked for when the user opts out of the default tail. Matches the daemon's own ceiling. */
const FULL_FILE_LINES = 50_000;

/** Level chip tint — the same severity palette the plugin log panel uses. */
const LEVEL_CLASS: Record<LogLevel, string> = {
  debug: 'text-muted-foreground/70',
  info: 'text-muted-foreground',
  warn: 'text-warning',
  error: 'text-destructive',
};

type CodeEditor = Parameters<OnMount>[0];

/** How close to the bottom (px) still counts as "reading the tail" — roughly a line. Within it a live
 *  refresh follows the newest line; past it the reader has scrolled up and their position is kept. */
const SCROLL_BOTTOM_SLACK = 8;

/** Read-only Monaco viewer for the Elowen log files: pick a file, filter it, delete what is stale. */
export function LogsModal({ onClose }: { onClose: () => void }) {
  const { t, locale } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [query, setQuery] = useState('');
  // The input stays immediate; the heavy work (filtering up to 50k lines, rebuilding the buffer and
  // replacing the Monaco model) runs against a deferred copy so a keystroke never blocks on it.
  const deferredQuery = useDeferredValue(query);
  const [levels, setLevels] = useState<ReadonlySet<LogLevel>>(new Set<LogLevel>());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  // The filter/severity signature of the content last written to the editor, or null for a fresh editor
  // instance (it remounts per file via key={selected}). Scroll is only preserved when a refresh is for
  // this SAME view; a first fill or a filter change instead shows the top of the new results.
  const filledView = useRef<string | null>(null);

  // The list and the selected file's tail poll on their own while the modal is open (both queries only
  // exist while it is mounted). A full-file read is not polled — it must not re-pull a large payload.
  const list = useLogFiles(true, true);
  const file = useLogFile(selected, full ? FULL_FILE_LINES : undefined, !full);
  const deleteOne = useDeleteLogFile();
  const deleteAll = useDeleteAllLogFiles();

  // The read is a TAIL, so the gutter has to start where the window starts — otherwise every number is
  // off by the dropped prefix, which is most of the file on any busy day.
  const parsed = useMemo(
    () => parseLogLines(file.data?.lines ?? [], file.data ? file.data.totalLines - file.data.lines.length + 1 : 1),
    [file.data],
  );
  const visible = useMemo(() => filterLogLines(parsed, { query: deferredQuery, levels }), [parsed, deferredQuery, levels]);
  // Monaco also breaks a model on a bare \r, so a captured line carrying one would produce more editor
  // lines than entries here and shift every gutter number below it. Strip them: the log is line-oriented.
  const text = useMemo(() => visible.map((l) => l.text.replace(/\r/g, '')).join('\n'), [visible]);
  // The current view's identity: the same filter/severity inputs `text` is built from. When it changes,
  // `text` is a different document and a scroll position captured against the previous one is meaningless.
  const viewKey = useMemo(() => JSON.stringify([deferredQuery, [...levels].sort()]), [deferredQuery, levels]);

  // Feed Monaco by hand instead of the controlled `value` prop. On a read-only editor that prop calls
  // setValue on every change, which slams the scroll back to the top — turning each poll into a jump.
  // A first fill and a filter change leave the view at the top; a live refresh of the SAME view keeps the
  // reader's scroll, following the tail only when they are already parked at the bottom.
  useEffect(() => {
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const sameView = filledView.current === viewKey;
    // Nothing to write — record the view so a later poll for it counts as the same view, then stop.
    if (model.getValue() === text) { filledView.current = viewKey; return; }
    const atBottom = sameView && editor.getScrollTop() >= editor.getScrollHeight() - editor.getLayoutInfo().height - SCROLL_BOTTOM_SLACK;
    const top = editor.getScrollTop();
    const action = refreshScrollAction(sameView, atBottom);
    filledView.current = viewKey;
    model.setValue(text);
    // Follow the tail via Monaco's own reveal, not setScrollTop(scrollHeight): with word wrap the wrapped
    // line heights settle after setValue, so a pixel target lands short of the true bottom and following
    // silently stops. Revealing the last line pins the view to the tail regardless.
    if (action === 'follow') editor.revealLine(model.getLineCount());
    else if (action === 'keep') editor.setScrollTop(top);
  }, [text, viewKey, editor]);

  const onEditorMount: OnMount = (instance): void => { filledView.current = null; setEditor(instance); };

  const toggleLevel = (level: LogLevel): void => {
    setLevels((cur) => {
      const next = new Set(cur);
      if (next.has(level)) next.delete(level); else next.add(level);
      return next;
    });
  };

  // Selecting a different file drops the "whole file" opt-in: it is a per-file choice, and silently
  // carrying it over would pull 50k lines of an unrelated log the user only meant to glance at.
  const pick = (name: string): void => { setSelected(name); setFull(false); };

  const files = list.data?.files ?? [];

  // Distinguish the two failure modes the read endpoint has from a generic failure: a 404 means the file
  // was deleted from under the viewer, a 413 means it is over the server's read cap. Both otherwise render
  // as an empty pane, indistinguishable from an empty log.
  const readErrorMessage = (error: unknown): string => {
    const status = error instanceof ElowenApiError ? error.status : 0;
    if (status === 404) return t.settings.logsErrorGone;
    if (status === 413) return t.settings.logsErrorTooBig;
    return t.settings.logsError;
  };

  return (
    <>
      <Modal title={t.settings.logs} description={list.data?.dir} icon={ScrollText} onClose={onClose}>
        {/* The file list is a 16rem companion column on a desktop dialog and a short stacked list above
            the viewer on a phone. It used to be `w-64 shrink-0` unconditionally, which left roughly
            130px for the editor inside the fullscreen presentation a phone gets. Container, not
            viewport: the same dialog is a drawer on a wide screen. */}
        <div className="@container flex min-h-0 flex-1 flex-col gap-4 p-4 @2xl:flex-row">
          <div className="flex max-h-52 shrink-0 flex-col gap-2 @2xl:max-h-none @2xl:w-64">
            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
              {files.length === 0 ? (
                <EmptyState title={t.settings.logsEmpty} icon={ScrollText} />
              ) : (
                files.map((f) => (
                  <div
                    key={f.name}
                    className={`flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0 ${f.name === selected ? 'bg-accent' : ''}`}
                  >
                    <button type="button" aria-current={f.name === selected} className="min-w-0 flex-1 text-left" onClick={() => pick(f.name)}>
                      <div className="truncate text-xs text-foreground">{f.name}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Badge>{f.source}</Badge>
                        <span>{formatBytes(f.bytes)}</span>
                        <span>{new Date(f.modifiedAt).toLocaleTimeString(locale)}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label={t.settings.logsDeleteFile}
                      title={t.settings.logsDeleteFile}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                      onClick={() => setPendingDelete(f.name)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
            {/* Below the list, not above it: a destructive action that clears everything belongs after the
                thing it destroys, where it cannot be hit on the way to picking a file. */}
            <div className="flex items-center justify-end gap-2">
              <Button variant="danger" icon={Trash2} disabled={files.length === 0 || deleteAll.isPending} onClick={() => setDeleteAllOpen(true)}>
                {t.settings.logsDeleteAll}
              </Button>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="max-w-xs"
                placeholder={t.settings.logsSearch}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={!selected}
              />
              {LOG_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={levels.has(level)}
                  disabled={!selected}
                  onClick={() => toggleLevel(level)}
                  className={`rounded-md border px-2 py-1 text-[11px] uppercase transition-colors disabled:opacity-40 ${
                    levels.has(level) ? 'border-primary bg-accent' : 'border-border'
                  } ${LEVEL_CLASS[level]}`}
                >
                  {level}
                </button>
              ))}
              {selected && file.data ? (
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {t.settings.logsMatches.replace('{n}', String(visible.length)).replace('{total}', String(parsed.length))}
                </span>
              ) : null}
            </div>

            {selected && file.data?.truncated ? (
              <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground">
                <span>
                  {/* Once the whole file was requested, a still-truncated read means the file is over the
                      viewer's line ceiling — the count is honest but the button no longer does anything, so
                      it is dropped and the wording says the limit is the viewer's. */}
                  {(full ? t.settings.logsTruncatedCapped : t.settings.logsTruncated)
                    .replace('{n}', String(file.data.lines.length))
                    .replace('{total}', String(file.data.totalLines))}
                </span>
                {!full ? (
                  <Button variant="ghost" onClick={() => setFull(true)} disabled={file.isFetching}>
                    {t.settings.logsLoadFull}
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
              {!selected ? (
                <EmptyState title={t.settings.logsPickFile} icon={ScrollText} />
              ) : file.isLoading ? (
                // Only for a read with nothing yet on screen — `isLoading` stays false on the 3s background
                // refetch, so a poll never flashes a spinner over content the user is reading.
                <LoadingState />
              ) : file.isError ? (
                // Surface the failure even when a previous read is still cached: a file deleted from under
                // the viewer (404) keeps its last data, so showing the editor here would freeze stale
                // content on screen while the file is gone. The retry clears the error and resumes polling.
                <ErrorState message={readErrorMessage(file.error)} onRetry={() => file.refetch()} />
              ) : (
                <MonacoEditor
                  key={selected}
                  height="100%"
                  language="plaintext"
                  theme={editorTheme()}
                  beforeMount={defineEditorThemes}
                  onMount={onEditorMount}
                  options={{
                    readOnly: true,
                    fontSize: 12,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    wordWrap: 'on',
                    folding: false,
                    renderLineHighlight: 'none',
                    // Keep the ORIGINAL file line numbers in the gutter. Filtering removes lines, so
                    // Monaco's own 1..n would renumber the view and quietly lie about where a record
                    // actually sits in the log.
                    lineNumbers: (n: number) => String(visible[n - 1]?.n ?? ''),
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t.settings.logsDeleteFileTitle}
        description={pendingDelete ? t.settings.logsDeleteFileDesc.replace('{name}', pendingDelete) : undefined}
        confirmLabel={t.common.delete}
        onConfirm={() => {
          const name = pendingDelete;
          setPendingDelete(null);
          if (!name) return;
          deleteOne.mutate(name, { onSuccess: () => { if (name === selected) setSelected(null); } });
        }}
        onClose={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={deleteAllOpen}
        title={t.settings.logsDeleteAllTitle}
        description={t.settings.logsDeleteAllDesc}
        confirmLabel={t.common.delete}
        onConfirm={() => {
          setDeleteAllOpen(false);
          deleteAll.mutate(undefined, { onSuccess: () => setSelected(null) });
        }}
        onClose={() => setDeleteAllOpen(false)}
      />
    </>
  );
}
