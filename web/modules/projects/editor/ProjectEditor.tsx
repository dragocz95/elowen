'use client';
import { useMemo, useRef, useState, useEffect } from 'react';
import { File as FileIcon, Save, Code2, GitCompare, X, FilePlus, FolderPlus, Pencil, Copy, Trash2, ClipboardCopy, Eye, WrapText, Maximize2, Minimize2, PanelLeft, ChevronLeft } from 'lucide-react';
import {
  useProjectFiles, useProjectFile, useProjectFileAtHead, useProjectCommit, useProjectCommitFileDiff,
  useProjectChanged, useProjectChanges,
} from '../../../lib/queries';
import {
  useWriteProjectFile, useNewProjectFile, useNewProjectDir, useRenameProjectEntry, useCopyProjectEntry, useDeleteProjectEntry,
} from '../../../lib/mutations';
import { Button } from '../../../components/ui/Button';
import { LoadingState, EmptyState } from '../../../components/ui/states';
import { useToast } from '../../../components/ui/Toast';
import { useTranslation } from '../../../lib/i18n';
import { buildTree, basename, parentDir, joinPath, copyName, isImage, isMarkdown, type TreeNode } from './helpers';
import { FileTree } from './FileTree';
import { ContextMenu, DIVIDER, type ContextMenuState, type MenuEntry } from '../../../components/ui/ContextMenu';
import { PromptDialog, ConfirmDialog } from './dialogs';
import { EditorPane } from './EditorPane';
import { DiffEditorPane } from './DiffEditorPane';
import { PatchView } from './PatchView';
import { MarkdownPreview } from './MarkdownPreview';
import { ImagePreview } from './ImagePreview';
import { Tabs } from './Tabs';
import { useMobile } from '../../../lib/useMobile';

type Tab = 'edit' | 'diff' | 'preview';
type Dialog =
  | { kind: 'newFile' | 'newFolder'; dir: string }
  | { kind: 'rename' | 'duplicate' | 'delete'; target: string };

// Embedded (non-fullscreen) editor height, persisted per device. The user drags the full bottom edge
// (see the resize handle below); Monaco reflows itself via `automaticLayout`.
const EDITOR_H_KEY = 'elowen:editor:height';
const MIN_EDITOR_H = 320;
const clampEditorH = (px: number) =>
  Math.max(MIN_EDITOR_H, Math.min(typeof window !== 'undefined' ? window.innerHeight * 0.96 : 4000, px));

/** Full project code editor: file tree with a right-click file-manager (new/rename/duplicate/delete),
 *  open-file tabs, Monaco editor (Cmd+S save), side-by-side working diff, Markdown/image previews,
 *  plus read-only commit-diff views when opened from the git log. */
export function ProjectEditor({ projectId, onClose, initialCommit, initialWorking, fill = false }: { projectId: number; onClose?: () => void; initialCommit?: string | null; initialWorking?: boolean; fill?: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const files = useProjectFiles(projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [commit] = useState<string | null>(initialCommit ?? null);
  const [working] = useState<boolean>(!!initialWorking);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>('edit');
  const [wordWrap, setWordWrap] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Embedded height (px), hydrated from localStorage on mount; defaults to ~70vh.
  const [editorH, setEditorH] = useState(560);
  const dragY = useRef<number | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  // On mobile the file tree is hidden by default in fullscreen (it eats too much of the narrow
  // viewport); a toggle surfaces it as an overlay. On desktop the tree is always visible.
  const mobile = useMobile();
  const [showTree, setShowTree] = useState(false);

  // Hydrate the saved embedded height (or fall back to ~70vh) once on mount, then persist on change.
  useEffect(() => {
    let stored: number | null = null;
    try {
      const raw = localStorage.getItem(EDITOR_H_KEY);
      if (raw) { const n = Number(raw); if (Number.isFinite(n)) stored = n; }
    } catch { /* localStorage unavailable (private mode / SSR) */ }
    setEditorH(clampEditorH(stored ?? window.innerHeight * 0.7));
  }, []);
  useEffect(() => {
    try { localStorage.setItem(EDITOR_H_KEY, String(editorH)); } catch { /* ignore */ }
  }, [editorH]);

  const commitData = useProjectCommit(projectId, commit);
  const changesData = useProjectChanges(projectId, working);
  const commitFileDiff = useProjectCommitFileDiff(projectId, commit, commit ? selected : null);
  // Keep the raw query value (stable ref) out of the memo deps; default to [] inside the callback so a
  // fresh `?? []` doesn't change the deps on every render.
  const workingChanged = useProjectChanged(projectId).data?.changed;
  // In commit mode highlight the files that commit touched; otherwise the uncommitted working set.
  const changedSet = useMemo(
    () => new Set(commit ? (commitData.data?.files ?? []) : (workingChanged ?? [])),
    [commit, commitData.data?.files, workingChanged],
  );

  const fileData = useProjectFile(projectId, selected);
  const write = useWriteProjectFile();
  const newFile = useNewProjectFile();
  const newDir = useNewProjectDir();
  const rename = useRenameProjectEntry();
  const copy = useCopyProjectEntry();
  const del = useDeleteProjectEntry();

  const tree = useMemo(() => buildTree(files.data ?? []), [files.data]);
  const serverContent = fileData.data?.content ?? '';
  const draft = selected != null ? drafts[selected] : undefined;
  const value = draft ?? serverContent;
  const dirty = selected != null && dirtyPaths.has(selected);
  const img = selected != null && isImage(selected);
  const md = selected != null && isMarkdown(selected);
  const editable = selected != null && !img && !commit && !working;
  const effTab: Tab = tab === 'preview' && !md ? 'edit' : tab;

  const headData = useProjectFileAtHead(projectId, selected, editable && effTab === 'diff');

  const openFile = (p: string) => { setSelected(p); setOpenTabs((tabs) => (tabs.includes(p) ? tabs : [...tabs, p])); setTab('edit'); };
  // In commit mode, picking a file shows its diff within that commit (read-only); else open the file.
  const selectInTree = (p: string) => { if (commit) setSelected(p); else openFile(p); };
  const onChange = (v: string) => {
    if (selected == null) return;
    setDrafts((d) => ({ ...d, [selected]: v }));
    setDirtyPaths((s) => { const n = new Set(s); v !== serverContent ? n.add(selected) : n.delete(selected); return n; });
  };
  const toggle = (p: string) => setExpanded((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const expandPath = (dir: string) => setExpanded((s) => { const n = new Set(s); let acc = ''; for (const part of dir.split('/').filter(Boolean)) { acc = acc ? `${acc}/${part}` : part; n.add(acc); } return n; });

  // Esc leaves fullscreen (without closing the editor); ignored while a dialog/menu owns Esc.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !dialog && !menu) { e.stopPropagation(); setFullscreen(false); setShowTree(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, dialog, menu]);

  // Auto-fullscreen on mobile so the editor owns the whole viewport (the 70vh inline view is too
  // cramped on a phone); the user can still exit to the inline card via the toolbar toggle.
  useEffect(() => { if (mobile) setFullscreen(true); }, [mobile]);
  // Reset the tree overlay whenever it stops being relevant (exit fullscreen, or switch to desktop).
  useEffect(() => { if (!fullscreen || !mobile) setShowTree(false); }, [fullscreen, mobile]);

  const save = () => {
    if (selected == null) return;
    const path = selected;
    write.mutate({ id: projectId, path, content: value }, {
      onSuccess: () => { setDrafts((d) => { const n = { ...d }; delete n[path]; return n; }); setDirtyPaths((s) => { const n = new Set(s); n.delete(path); return n; }); toast(t.projects.fileSaved.replace('{path}', path)); },
      onError: (e) => toast(String(e), 'error'),
    });
  };

  const closeTab = (p: string) => {
    setOpenTabs((tabs) => {
      const next = tabs.filter((x) => x !== p);
      if (selected === p) setSelected(next[next.length - 1] ?? null);
      return next;
    });
  };

  // Drop a path (and anything under it, for a directory) from open tabs, drafts, and selection.
  const forgetPath = (path: string) => {
    const under = (x: string) => x === path || x.startsWith(path + '/');
    setOpenTabs((tabs) => tabs.filter((x) => !under(x)));
    setDrafts((d) => { const n = { ...d }; for (const k of Object.keys(n)) if (under(k)) delete n[k]; return n; });
    setDirtyPaths((s) => { const n = new Set([...s].filter((x) => !under(x))); return n; });
    setSelected((s) => (s && under(s) ? null : s));
  };
  // Re-point a moved path (and descendants) across tabs, drafts, and selection.
  const remapPath = (from: string, to: string) => {
    const remap = (x: string) => (x === from ? to : x.startsWith(from + '/') ? to + x.slice(from.length) : x);
    setOpenTabs((tabs) => tabs.map(remap));
    setDrafts((d) => { const n: Record<string, string> = {}; for (const [k, v] of Object.entries(d)) n[remap(k)] = v; return n; });
    setDirtyPaths((s) => new Set([...s].map(remap)));
    setSelected((s) => (s ? remap(s) : s));
  };

  const err = (e: unknown) => toast(String(e), 'error');
  const copyPath = (p: string) => { navigator.clipboard?.writeText(p).then(() => toast(t.projects.pathCopied)).catch(() => {}); };

  const submitDialog = (val: string) => {
    if (!dialog) return;
    if (dialog.kind === 'newFile') {
      const path = joinPath(dialog.dir, val);
      newFile.mutate({ id: projectId, path }, { onSuccess: () => { expandPath(dialog.dir); openFile(path); toast(t.projects.fileCreated.replace('{path}', path)); }, onError: err });
    } else if (dialog.kind === 'newFolder') {
      const path = joinPath(dialog.dir, val);
      newDir.mutate({ id: projectId, path }, { onSuccess: () => { expandPath(path); toast(t.projects.folderCreated.replace('{path}', path)); }, onError: err });
    } else if (dialog.kind === 'rename') {
      const to = joinPath(parentDir(dialog.target), val);
      rename.mutate({ id: projectId, from: dialog.target, to }, { onSuccess: () => { remapPath(dialog.target, to); toast(t.projects.renamed.replace('{path}', to)); }, onError: err });
    } else if (dialog.kind === 'duplicate') {
      const to = joinPath(parentDir(dialog.target), val);
      copy.mutate({ id: projectId, from: dialog.target, to }, { onSuccess: () => { toast(t.projects.duplicated.replace('{path}', to)); }, onError: err });
    }
    setDialog(null);
  };
  const confirmDelete = () => {
    if (dialog?.kind !== 'delete') return;
    const path = dialog.target;
    del.mutate({ id: projectId, path }, { onSuccess: () => { forgetPath(path); toast(t.projects.deleted.replace('{path}', path)); }, onError: err });
    setDialog(null);
  };

  // Build the right-click menu for a node (file or dir) or the tree background (null → project root).
  const buildMenu = (node: TreeNode | null): MenuEntry[] => {
    if (!node) return [
      { label: t.projects.ctxNewFile, icon: FilePlus, onClick: () => setDialog({ kind: 'newFile', dir: '' }) },
      { label: t.projects.ctxNewFolder, icon: FolderPlus, onClick: () => setDialog({ kind: 'newFolder', dir: '' }) },
    ];
    const common: MenuEntry[] = [
      { label: t.projects.ctxRename, icon: Pencil, onClick: () => setDialog({ kind: 'rename', target: node.path }) },
      { label: t.projects.ctxDuplicate, icon: Copy, onClick: () => setDialog({ kind: 'duplicate', target: node.path }) },
      { label: t.projects.ctxDelete, icon: Trash2, danger: true, onClick: () => setDialog({ kind: 'delete', target: node.path }) },
      DIVIDER,
      { label: t.projects.ctxCopyPath, icon: ClipboardCopy, onClick: () => copyPath(node.path) },
    ];
    if (node.type === 'dir') return [
      { label: t.projects.ctxNewFile, icon: FilePlus, onClick: () => setDialog({ kind: 'newFile', dir: node.path }) },
      { label: t.projects.ctxNewFolder, icon: FolderPlus, onClick: () => setDialog({ kind: 'newFolder', dir: node.path }) },
      DIVIDER, ...common,
    ];
    return [
      { label: t.projects.ctxOpen, icon: FileIcon, onClick: () => openFile(node.path) },
      DIVIDER, ...common,
    ];
  };
  const onContextMenu = (e: React.MouseEvent, node: TreeNode | null) => setMenu({ x: e.clientX, y: e.clientY, items: buildMenu(node) });

  const dialogTitle = dialog?.kind === 'newFile' ? t.projects.dlgNewFile
    : dialog?.kind === 'newFolder' ? t.projects.dlgNewFolder
    : dialog?.kind === 'rename' ? t.projects.dlgRename
    : dialog?.kind === 'duplicate' ? t.projects.dlgDuplicate : '';
  const dialogInitial = dialog?.kind === 'rename' ? basename(dialog.target)
    : dialog?.kind === 'duplicate' ? basename(copyName(dialog.target)) : '';

  return (
    <div
      className={fullscreen
        ? 'fixed inset-0 z-50 flex h-screen flex-col overflow-hidden bg-surface'
        : 'flex flex-col overflow-hidden border-y border-border bg-[#030303]'}
      style={fullscreen ? undefined : { height: fill ? 'calc(100dvh - 13rem)' : editorH }}
    >
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {/* On mobile fullscreen the editor covers the app nav, so a prominent back button is the way
            out of the editor (calls onClose → leaves back to the app). */}
        {mobile && fullscreen && onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t.common.back}
            title={t.common.back}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <ChevronLeft size={18} />
          </button>
        )}
        {/* On mobile (fullscreen + tree hidden) a toggle surfaces the file tree as an overlay. */}
        {mobile && fullscreen && (
          <button
            type="button"
            onClick={() => setShowTree((s) => !s)}
            aria-pressed={showTree}
            aria-label={t.projects.toggleTree}
            title={t.projects.toggleTree}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${showTree ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-elevated hover:text-text'}`}
          >
            <PanelLeft size={15} />
          </button>
        )}
        <Code2 size={15} className="shrink-0 text-accent" aria-hidden />
        {/* On a phone the toolbar is tight (back + tree toggle + tab buttons), so drop the static
            "Code editor" label — the icon is marker enough — and keep the row to one line. */}
        {!(mobile && fullscreen) && <span className="text-sm font-semibold text-text">{t.projects.editorTitle}</span>}
        {working ? <span className="truncate font-mono text-xs text-warning"><GitCompare size={11} className="mr-1 inline" aria-hidden />{t.projects.workingChanges}</span>
          : commit ? <button type="button" onClick={() => setSelected(null)} disabled={!selected} title={selected ? t.projects.viewCommit : undefined} className="flex min-w-0 items-center truncate font-mono text-xs text-accent transition-colors enabled:hover:text-text disabled:cursor-default"><GitCompare size={11} className="mr-1 inline shrink-0" aria-hidden /><span className="truncate">{t.projects.commitLabel} {commit.slice(0, 8)}{selected ? ` · ${selected}` : ''}</span></button>
          : null}
        <div className="ml-auto flex items-center gap-1.5">
          {editable ? (
            <>
              <Button variant={effTab === 'edit' ? 'accent' : 'ghost'} onClick={() => setTab('edit')}>{t.projects.tabEdit}</Button>
              {md ? <Button variant={effTab === 'preview' ? 'accent' : 'ghost'} icon={Eye} onClick={() => setTab('preview')}>{t.projects.tabPreview}</Button> : null}
              <Button variant={effTab === 'diff' ? 'accent' : 'ghost'} icon={GitCompare} onClick={() => setTab('diff')}>{t.projects.tabDiff}</Button>
              <Button variant={wordWrap ? 'accent' : 'ghost'} icon={WrapText} aria-label={t.projects.wordWrap} title={t.projects.wordWrap} onClick={() => setWordWrap((w) => !w)} />
              <Button variant="accent" icon={Save} disabled={!dirty || write.isPending} onClick={save}>{t.common.save}</Button>
            </>
          ) : null}
          {onClose && !(mobile && fullscreen) ? <button type="button" aria-label={t.common.close} onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"><X size={15} /></button> : null}
        </div>
      </div>

      {/* `relative` scopes the mobile tree overlay (absolute) to this row — without it the overlay
          resolves against the fixed fullscreen container and rides up over the toolbar. */}
      <div className="relative flex min-h-0 flex-1">
        {/* File tree. On desktop it's a fixed 256px sidebar. On mobile fullscreen it's a togglable
            overlay (default hidden) so it never eats the narrow viewport. */}
        {(mobile && fullscreen && !showTree) ? null : (
          <div
            className={`flex shrink-0 flex-col border-r border-border ${(mobile && fullscreen) ? 'absolute inset-y-0 left-0 z-10 w-[80%] max-w-72 bg-surface shadow-lg' : 'w-64 bg-bg/40'}`}
          >
            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              {files.isLoading ? <LoadingState />
                : <FileTree tree={tree} expanded={expanded} onToggle={toggle} selected={selected} onSelect={(p) => { selectInTree(p); if (mobile && fullscreen) setShowTree(false); }} changed={changedSet} onContextMenu={onContextMenu} emptyLabel={t.projects.noFiles} treeLabel={t.projects.editorTitle} />}
            </div>
            <div className="shrink-0 border-t border-border p-1.5">
              <button
                type="button"
                onClick={() => setFullscreen((f) => !f)}
                aria-pressed={fullscreen}
                title={fullscreen ? t.projects.exitFullscreen : t.projects.fullscreen}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-elevated px-2 py-1.5 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text"
              >
                {fullscreen ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
                {fullscreen ? t.projects.exitFullscreen : t.projects.fullscreen}
              </button>
            </div>
          </div>
        )}

        {/* editor / diff / preview / commit / working changes */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!commit && !working ? <Tabs tabs={openTabs} active={selected} dirty={dirtyPaths} onSelect={setSelected} onClose={closeTab} closeLabel={t.common.close} /> : null}
          <div className="min-h-0 flex-1">
            {working ? <PatchView diff={changesData.data?.diff ?? ''} empty={changesData.isLoading ? t.common.loading : t.projects.noChanges} />
              : commit && selected ? <PatchView diff={commitFileDiff.data?.diff ?? ''} empty={commitFileDiff.isLoading ? t.common.loading : t.projects.noChanges} />
              : commit ? <PatchView diff={commitData.data?.diff ?? ''} empty={commitData.isLoading ? t.common.loading : t.projects.noChanges} />
              : !selected ? <EmptyState title={t.projects.selectFile} icon={FileIcon} />
              : img ? <ImagePreview projectId={projectId} path={selected} />
              : fileData.data?.truncated ? <p className="p-4 text-center text-sm text-text-muted">{t.projects.fileTooBig}</p>
              : effTab === 'diff' ? (headData.isLoading ? <LoadingState /> : <DiffEditorPane path={selected} original={headData.data?.content ?? ''} modified={value} />)
              : effTab === 'preview' ? <MarkdownPreview source={value} />
              : <EditorPane path={selected} value={value} onChange={onChange} onSave={save} wordWrap={wordWrap} />}
          </div>
        </div>
      </div>

      {/* Full-width bottom drag edge: grab anywhere along it to resize the embedded editor. The centered
          pill hints at the affordance (same visual language as the sidebar handle). */}
      {!fullscreen && !fill ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t.projects.resizeEditor}
          title={t.projects.resizeEditor}
          onPointerDown={(e) => { e.preventDefault(); dragY.current = e.clientY; e.currentTarget.setPointerCapture?.(e.pointerId); }}
          onPointerMove={(e) => { if (dragY.current === null) return; const dy = e.clientY - dragY.current; dragY.current = e.clientY; setEditorH((h) => clampEditorH(h + dy)); }}
          onPointerUp={(e) => { if (dragY.current === null) return; dragY.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId); }}
          onLostPointerCapture={() => { dragY.current = null; }}
          className="group flex h-3.5 shrink-0 cursor-row-resize items-center justify-center border-t border-border bg-bg/40 transition-colors hover:bg-elevated"
        >
          <span className="h-1 w-10 rounded-full bg-border transition-all duration-200 group-hover:w-16 group-hover:bg-text-muted" />
        </div>
      ) : null}

      {menu ? <ContextMenu state={menu} onClose={() => setMenu(null)} /> : null}
      {dialog && dialog.kind === 'delete'
        ? <ConfirmDialog title={t.projects.dlgDelete} message={t.projects.dlgDeleteMsg.replace('{name}', basename(dialog.target))} confirmLabel={t.projects.ctxDelete} danger icon={Trash2} onConfirm={confirmDelete} onCancel={() => setDialog(null)} />
        : dialog
        ? <PromptDialog title={dialogTitle} label={t.projects.dlgName} initialValue={dialogInitial} confirmLabel={t.common.save} onConfirm={submitDialog} onCancel={() => setDialog(null)} />
        : null}
    </div>
  );
}
