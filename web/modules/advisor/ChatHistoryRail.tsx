'use client';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Trash2, X, MoreVertical, Pencil, Download } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { elowenClient } from '../../lib/elowenClient';
import { formatTaskTime } from '../../lib/format';
import type { BrainSearchHit } from '../../lib/types';
import { useBrainChat } from './BrainChatProvider';

/** A search snippet with the first occurrence of the query highlighted. */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-accent/30 px-0.5 text-text">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

const MENU_ITEM = 'flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-text-muted transition-colors hover:bg-elevated hover:text-text';

/** The single source for the conversation history: list + fulltext search + switch / new / rename /
 *  export / delete. Rendered three ways — the persistent left `rail` on /chat desktop, the mobile
 *  `drawer` slide-over, and the compact dock's `dropdown` popover — all off the one shared controller
 *  (BrainChatProvider) so there is never a second session list or a second mutation surface. Delete goes
 *  through the controller (it re-targets the active conversation); rename/export/search hit the client
 *  directly (pure metadata / read-only), mirroring Fáze 1's search split. */
export function ChatHistoryRail({ variant, open = false, onClose, className }: {
  variant: 'rail' | 'drawer' | 'dropdown';
  open?: boolean;
  onClose?: () => void;
  className?: string;
}) {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { sessions, switchSession, deleteSession } = useBrainChat();

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<BrainSearchHit[] | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renameFor, setRenameFor] = useState<string | null>(null);
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
    setMenuFor(null);
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

  const exportSession = (id: string, format: 'html' | 'jsonl') => {
    setMenuFor(null);
    void elowenClient.brainExportSession(id, format).catch(() => toast(t.chat.exportError, 'error'));
  };

  const removeSession = (id: string, active: boolean) => {
    setMenuFor(null);
    dismiss();
    void deleteSession(id, active);
  };

  const q = search.trim();
  const listScroll = variant === 'dropdown' ? 'flex flex-col' : 'flex min-h-0 flex-1 flex-col overflow-y-auto';

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      {variant !== 'dropdown' ? (
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{t.chat.historyTitle}</span>
          <button
            type="button"
            onClick={() => openSession({ fresh: true })}
            aria-label={t.brainChat.newChat}
            title={t.brainChat.newChat}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <Plus size={16} aria-hidden />
          </button>
          {variant === 'drawer' ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t.advisor.close}
              title={t.advisor.close}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
            >
              <X size={16} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Fulltext search across the caller's conversations; a live query swaps the list for hits. */}
      <div className="m-1 flex items-center gap-1.5 rounded-md border border-border bg-bg px-2">
        <Search size={13} className="shrink-0 text-text-muted" aria-hidden />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.brainChat.searchPlaceholder}
          aria-label={t.brainChat.searchPlaceholder}
          autoFocus={variant !== 'rail'}
          className="w-full bg-transparent py-1.5 text-sm text-text placeholder:text-text-muted focus:outline-none"
        />
      </div>

      <div className={`${listScroll} px-1 pb-1`}>
        {q.length >= 2 ? (
          results === null ? null : results.length === 0 ? (
            <p className="px-2 py-2 text-xs text-text-muted">{t.brainChat.searchEmpty}</p>
          ) : (
            results.map((h, i) => {
              const when = formatTaskTime(h.ts, Date.now(), locale);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => openSession({ session: h.sessionId })}
                  className="flex w-full flex-col rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface"
                >
                  <span className="flex w-full items-baseline justify-between gap-2">
                    <span className="truncate text-sm text-text">{h.sessionTitle || t.brainChat.untitled}</span>
                    <span className="shrink-0 text-tiny text-text-muted" title={when.title}>{when.label}</span>
                  </span>
                  <span className="w-full truncate text-tiny text-text-muted">
                    <Highlight text={h.snippet} query={q} />
                  </span>
                </button>
              );
            })
          )
        ) : sessions.isLoading && !sessions.data ? null : (sessions.data ?? []).length === 0 ? (
          <p className="px-2 py-2 text-xs text-text-muted">{t.chat.emptyHistory}</p>
        ) : (sessions.data ?? []).map((s) => (
          <div key={s.id} className={`group relative flex items-center rounded-md transition-colors hover:bg-surface ${s.active ? 'bg-surface' : ''}`}>
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
                className="m-1 w-full rounded-md border border-border bg-bg px-2 py-1 text-sm text-text focus:border-accent focus:outline-none"
              />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => openSession({ session: s.id })}
                  className="flex min-w-0 flex-1 flex-col px-2 py-1.5 text-left"
                >
                  <span className="truncate text-sm text-text">{s.title || t.brainChat.untitled}</span>
                  <span className="truncate font-mono text-tiny text-text-muted">{s.model}</span>
                </button>
                <div className="relative mr-1">
                  <button
                    type="button"
                    onClick={() => setMenuFor((v) => (v === s.id ? null : s.id))}
                    aria-label={t.chat.moreActions}
                    title={t.chat.moreActions}
                    aria-expanded={menuFor === s.id}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-all hover:bg-elevated hover:text-text ${menuFor === s.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                  >
                    <MoreVertical size={14} aria-hidden />
                  </button>
                  {menuFor === s.id ? (
                    <>
                      <div className="fixed inset-0 z-20" onClick={() => setMenuFor(null)} aria-hidden />
                      <div className="absolute right-0 top-full z-30 mt-1 flex w-44 flex-col rounded-md border border-border bg-surface p-1 shadow-lg">
                        <button type="button" onClick={() => beginRename(s.id, s.title || '')} className={MENU_ITEM}>
                          <Pencil size={13} aria-hidden /> {t.chat.rename}
                        </button>
                        <button type="button" onClick={() => exportSession(s.id, 'html')} className={MENU_ITEM}>
                          <Download size={13} aria-hidden /> {t.chat.exportHtml}
                        </button>
                        <button type="button" onClick={() => exportSession(s.id, 'jsonl')} className={MENU_ITEM}>
                          <Download size={13} aria-hidden /> {t.chat.exportJsonl}
                        </button>
                        <button type="button" onClick={() => removeSession(s.id, s.active)} className={`${MENU_ITEM} hover:text-red-400`}>
                          <Trash2 size={13} aria-hidden /> {t.brainChat.deleteChat}
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  if (variant === 'dropdown') {
    if (!open) return null;
    return (
      <div className="absolute left-2 right-2 top-full z-20 mt-1 flex max-h-72 flex-col overflow-y-auto rounded-lg border border-border bg-elevated p-1 shadow-lg">
        {body}
      </div>
    );
  }

  if (variant === 'drawer') {
    // Mounted only while open: a closed drawer keeps no focusable controls in the DOM (no tabbing into an
    // off-screen panel, no autofocus popping the mobile keyboard on page load). Escape and the backdrop
    // close it; focus lands in the search input on open (its autoFocus now fires on open, not on mount).
    if (!open) return null;
    return (
      <div className="fixed inset-0 z-40" onKeyDown={(e) => { if (e.key === 'Escape') onClose?.(); }}>
        <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
        <aside
          role="dialog"
          aria-modal="true"
          aria-label={t.chat.openHistory}
          className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col border-r border-border bg-surface shadow-xl"
        >
          {body}
        </aside>
      </div>
    );
  }

  return <aside aria-label={t.chat.historyTitle} className={`min-h-0 flex-col border-r border-border ${className ?? ''}`}>{body}</aside>;
}
