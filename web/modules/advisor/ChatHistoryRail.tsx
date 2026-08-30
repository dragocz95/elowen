'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Trash2, X, MoreVertical, Pencil, Download, GitBranch, ArrowLeft, Library } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/ActionMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Dialog, DialogContent } from '../../components/ui/shadcn/dialog';
import { focusOverlaySurface, useReturnFocus } from '../../components/ui/overlayStack';
import { elowenClient } from '../../lib/elowenClient';
import { formatTaskTime } from '../../lib/format';
import type { BrainSearchHit } from '../../lib/types';
import { useBrainChat } from './BrainChatProvider';
import { brainModelQualifiedLabel } from '../../lib/modelProvider';

/** A search snippet with the first occurrence of the query highlighted. */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-primary/30 px-0.5 text-foreground">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/** The phone slide-over, on the shadcn `Dialog` (Radix): the dialog role, the focus trap, Escape and the
 *  layer order among several open overlays are Radix's, so this file no longer writes any of them.
 *
 *  It is the one overlay shape in the app that does NOT take `useOverlayIsolation`: that stack isolates
 *  the background by marking every OTHER child of <body> inert, which needs an overlay portalled to the
 *  body. This drawer renders inside the chat shell, so its own body-level ancestor is what would be
 *  marked — the drawer would disable itself. Radix's `aria-hidden` sweep walks the ancestor chain
 *  instead and reaches the same surfaces from in here. What the stack still owns and Radix cannot is
 *  where focus goes on the way out, because there is no `Dialog.Trigger` to hand it back to. */
function HistoryDrawer({ label, onClose, children }: { label: string; onClose?: () => void; children: ReactNode }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { restoreFocus } = useReturnFocus();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <div
        className="overlay-layer-drawer fixed inset-0"
        // Radix's modal content sets `pointer-events: none` on <body> and re-enables them on itself;
        // this layer would inherit the block and the backdrop below would stop answering the click that
        // dismisses the drawer. Opting back in is what `DialogOverlay` does for the same reason.
        style={{ pointerEvents: 'auto' }}
      >
        <div className="absolute inset-0 bg-background/50" onClick={onClose} aria-hidden />
        <DialogContent
          ref={surfaceRef}
          // A left rail, which none of the primitive's presentations describes; the geometry stays here.
          // Only the geometry: `presentation={null}` drops the shape classes, but `.overlay-surface` is
          // in the variant BASE and still paints the ground, the border colour and the raised shadow —
          // so a `bg-card shadow-xl` written here was never what the reader saw, only a second answer to
          // a question `primitives.css` had already settled.
          presentation={null}
          aria-label={label}
          aria-describedby={undefined}
          className="absolute inset-y-0 left-0 w-72 max-w-[85%] border-r border-border"
          // The backdrop above already owns dismissal, and it is the only owner that knows a nested
          // overlay's backdrop must not close its parent.
          onInteractOutside={(event) => event.preventDefault()}
          // Focus lands in the search input, which asks for it with `[data-autofocus]`; Radix would take
          // the first control in the tab order (the dashboard link or "new chat") instead.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (surfaceRef.current) focusOverlaySurface(surfaceRef.current);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          {children}
        </DialogContent>
      </div>
    </Dialog>
  );
}

/** The single source for the conversation history: list + fulltext search + switch / new / rename /
 *  export / delete. Rendered three ways — the persistent left `rail` on /chat desktop, the mobile
 *  `drawer` slide-over, and the compact dock's `dropdown` popover — all off the one shared controller
 *  (BrainChatProvider) so there is never a second session list or a second mutation surface. Delete goes
 *  through the controller (it re-targets the active conversation); rename/export/search hit the client
 *  directly (pure metadata / read-only), mirroring Fáze 1's search split. */
export function ChatHistoryRail({ variant, open = false, onClose, className, homeLink = false, onOpenRegister }: {
  variant: 'rail' | 'drawer' | 'dropdown';
  open?: boolean;
  onClose?: () => void;
  className?: string;
  // On a phone /chat hides the global TopBar, so this drawer becomes the only way back to the app — it
  // then shows a "← dashboard" link at its top. Off everywhere the TopBar still carries navigation.
  homeLink?: boolean;
  // The Chat page passes this to surface the full conversation register (channels + task agents, admin
  // oversight, exports) as a modal; this list itself stays the caller's own conversations.
  onOpenRegister?: () => void;
}) {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { sessions, switchSession, deleteSession } = useBrainChat();

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<BrainSearchHit[] | null>(null);
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string; active: boolean } | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const deleteTargetRef = useRef<typeof deleteTarget>(null);
  const deletePendingRef = useRef(false);
  const deleteOpRef = useRef(0);
  const [renameValue, setRenameValue] = useState('');

  // Debounced conversation search: ≥2 chars queries the daemon; anything shorter restores the list.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setResults(null); return; }
    let stale = false;
    const timer = setTimeout(() => {
      elowenClient.brainSearch(q)
        .then((hits) => { if (!stale) setResults(hits); })
        .catch(() => { if (!stale) setResults([]); });
    }, 300);
    return () => { stale = true; clearTimeout(timer); };
  }, [search]);

  // A drawer/dropdown dismisses itself after an action; the persistent rail stays put.
  const dismiss = () => { if (variant !== 'rail') onClose?.(); };

  const openSession = (opts: { session?: string; fresh?: boolean }) => {
    setSearch('');
    dismiss();
    void switchSession(opts).catch(() => toast(t.brainChat.searchOpenError, 'error'));
  };

  // A rename resolves exactly once. Enter and blur commit; Escape cancels. The guard stops the blur that
  // browsers fire when the focused input unmounts from re-running the commit — otherwise Enter would PATCH
  // twice and Escape (which also unmounts) would commit the edit it was meant to discard.
  const renameDone = useRef(false);
  const beginRename = (id: string, title: string) => {
    renameDone.current = false;
    setRenameValue(title);
    setRenameFor(id);
  };
  const cancelRename = () => { renameDone.current = true; setRenameFor(null); };
  const commitRename = async (id: string) => {
    if (renameDone.current) return;
    renameDone.current = true;
    const title = renameValue.trim();
    setRenameFor(null);
    if (!title) return;
    try {
      await elowenClient.brainRenameSession(id, title);
      await qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    } catch { toast(t.chat.renameError, 'error'); }
  };

  // Branch a conversation and open the copy, so the user lands in the new thread and the original stays
  // untouched. The daemon creates it purely in the store, so this is a plain client call like rename.
  const forkSession = async (id: string) => {
    try {
      const fork = await elowenClient.brainForkSession(id);
      openSession({ session: fork.id });
    } catch { toast(t.chat.forkError, 'error'); }
  };

  const exportSession = (id: string, format: 'html' | 'jsonl') => {
    void elowenClient.brainExportSession(id, format).catch(() => toast(t.chat.exportError, 'error'));
  };

  const openDelete = (target: NonNullable<typeof deleteTarget>) => {
    deleteOpRef.current += 1;
    deletePendingRef.current = false;
    deleteTargetRef.current = target;
    setDeletePending(false);
    setDeleteTarget(target);
  };
  const closeDelete = () => {
    deleteOpRef.current += 1;
    deletePendingRef.current = false;
    deleteTargetRef.current = null;
    setDeletePending(false);
    setDeleteTarget(null);
  };
  const confirmDelete = async (): Promise<void> => {
    const target = deleteTargetRef.current;
    if (!target || deletePendingRef.current) return;
    const operation = ++deleteOpRef.current;
    deletePendingRef.current = true;
    setDeletePending(true);
    try {
      await deleteSession(target.id, target.active);
      if (operation !== deleteOpRef.current || deleteTargetRef.current !== target) return;
      deletePendingRef.current = false;
      deleteTargetRef.current = null;
      setDeletePending(false);
      setDeleteTarget(null);
      dismiss();
    } catch {
      if (operation !== deleteOpRef.current || deleteTargetRef.current !== target) return;
      // The provider owns the visible failure toast. Keeping the confirmation and list mounted preserves
      // the exact session state and lets the user retry without rediscovering the conversation.
      deletePendingRef.current = false;
      setDeletePending(false);
    }
  };

  const actionItems = (session: { id: string; title?: string; active: boolean }): ActionMenuItem[] => [
    { label: t.chat.rename, icon: Pencil, onSelect: () => beginRename(session.id, session.title || '') },
    { label: t.chat.fork, icon: GitBranch, onSelect: () => { void forkSession(session.id); } },
    { label: t.chat.exportHtml, icon: Download, onSelect: () => exportSession(session.id, 'html') },
    { label: t.chat.exportJsonl, icon: Download, onSelect: () => exportSession(session.id, 'jsonl') },
    {
      label: t.brainChat.deleteChat,
      icon: Trash2,
      tone: 'danger',
      onSelect: () => {},
      onAfterClose: () => openDelete({ id: session.id, title: session.title || t.brainChat.untitled, active: session.active }),
    },
  ];

  const q = search.trim();
  const listScroll = variant === 'dropdown' ? 'flex flex-col' : 'flex min-h-0 flex-1 flex-col overflow-y-auto';

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      {homeLink ? (
        <Link
          href="/dash"
          onClick={onClose}
          className="flex items-center gap-2 border-b border-border px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft size={16} aria-hidden />
          <span className="truncate">{t.nav.dashboard}</span>
        </Link>
      ) : null}
      {variant !== 'dropdown' ? (
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{t.chat.historyTitle}</span>
          <button
            type="button"
            onClick={() => openSession({ fresh: true })}
            aria-label={t.brainChat.newChat}
            title={t.brainChat.newChat}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus size={16} aria-hidden />
          </button>
          {variant === 'drawer' ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t.advisor.close}
              title={t.advisor.close}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X size={16} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Fulltext search across the caller's conversations; a live query swaps the list for hits. */}
      <div className="m-1 flex items-center gap-1.5 rounded-md border border-border bg-background px-2">
        <Search size={13} className="shrink-0 text-muted-foreground" aria-hidden />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.brainChat.searchPlaceholder}
          aria-label={t.brainChat.searchPlaceholder}
          // One owner per variant. The dropdown is a plain popover and focuses itself on mount; the
          // drawer is a dialog, where the surface's focus policy runs after mount and anchors on the
          // surface unless a control asks for the focus by name — so it asks.
          autoFocus={variant === 'dropdown'}
          data-autofocus={variant === 'drawer' ? '' : undefined}
          className="w-full bg-transparent py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>

      <div className={`${listScroll} px-1 pb-1`}>
        {q.length >= 2 ? (
          results === null ? null : results.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">{t.brainChat.searchEmpty}</p>
          ) : (
            results.map((h, i) => {
              const when = formatTaskTime(h.ts, Date.now(), locale);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => openSession({ session: h.sessionId })}
                  className="flex w-full flex-col rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                >
                  <span className="flex w-full items-baseline justify-between gap-2">
                    <span className="truncate text-sm text-foreground">{h.sessionTitle || t.brainChat.untitled}</span>
                    <span className="shrink-0 text-tiny text-muted-foreground" title={when.title}>{when.label}</span>
                  </span>
                  <span className="w-full truncate text-tiny text-muted-foreground">
                    <Highlight text={h.snippet} query={q} />
                  </span>
                </button>
              );
            })
          )
        ) : sessions.isLoading && !sessions.data ? null : (sessions.data ?? []).length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t.chat.emptyHistory}</p>
        ) : (sessions.data ?? []).map((s) => (
          <div key={s.id} className={`group relative flex items-center rounded-md transition-colors hover:bg-accent ${s.active ? 'bg-accent' : ''}`}>
            {renameFor === s.id ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void commitRename(s.id); }
                  if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                }}
                onBlur={() => void commitRename(s.id)}
                aria-label={t.chat.renamePlaceholder}
                placeholder={t.chat.renamePlaceholder}
                className="m-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => openSession({ session: s.id })}
                  className="flex min-w-0 flex-1 flex-col px-2 py-1.5 text-left"
                >
                  <span className="truncate text-sm text-foreground">{s.title || t.brainChat.untitled}</span>
                  <span className="truncate font-mono text-tiny text-muted-foreground">{brainModelQualifiedLabel({ provider: s.provider ?? '', model: s.model })}</span>
                </button>
                <div className="mr-1">
                  <ActionMenu
                    label={`${s.title || t.brainChat.untitled}: ${t.chat.moreActions}`}
                    items={actionItems(s)}
                    trigger={<MoreVertical size={14} aria-hidden />}
                    // Rename, branch, export and delete are reachable ONLY through this button, so it
                    // cannot be a hover affordance. Touch and keyboard always reveal it; fine pointers keep
                    // the quiet row treatment until hover, focus or Radix's open state.
                    triggerClassName="overlay-touch-target flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
                  />
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {onOpenRegister ? (
        <button
          type="button"
          onClick={() => { dismiss(); onOpenRegister(); }}
          className="flex shrink-0 items-center gap-2 border-t border-border px-2 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Library size={15} aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{t.chat.openRegister}</span>
            <span className="truncate text-tiny text-muted-foreground">{t.chat.registerHint}</span>
          </span>
        </button>
      ) : null}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t.brainChat.deleteChatConfirmTitle}
        description={deleteTarget ? t.brainChat.deleteChatConfirmDescription.replace('{title}', deleteTarget.title) : undefined}
        confirmLabel={t.brainChat.deleteChat}
        confirmDisabled={deletePending}
        onConfirm={confirmDelete}
        onClose={closeDelete}
      />
    </div>
  );

  if (variant === 'dropdown') {
    if (!open) return null;
    return (
      <div className="absolute left-2 right-2 top-full z-20 mt-1 flex max-h-72 flex-col overflow-y-auto rounded-lg border border-border bg-muted p-1 shadow-lg">
        {body}
      </div>
    );
  }

  if (variant === 'drawer') {
    // Mounted only while open: a closed drawer keeps no focusable controls in the DOM (no tabbing into an
    // off-screen panel, no autofocus popping the mobile keyboard on page load). Escape and the backdrop
    // close it; focus lands in the search input on open.
    if (!open) return null;
    return <HistoryDrawer label={t.chat.openHistory} onClose={onClose}>{body}</HistoryDrawer>;
  }

  return <aside aria-label={t.chat.historyTitle} className={`min-h-0 flex-col border-r border-border ${className ?? ''}`}>{body}</aside>;
}
