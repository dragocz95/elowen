'use client';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Search, CornerDownLeft, type LucideIcon } from 'lucide-react';
import { MODULES } from '../../modules/registry';
import { useTranslation } from '../../lib/i18n';
import { usePluginUi } from '../../lib/queries';
import { pluginNavEntries } from '../../lib/pluginNav';
import { useDialogOverlay } from '../ui/overlayStack';

interface Command { id: string; label: string; hint?: string; icon: LucideIcon; run: () => void }

export const COMMAND_PALETTE_OPEN_EVENT = 'elowen:open-command-palette';

/** Accent-highlight the matched query substring within a label. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<span className="text-primary">{text.slice(i, i + q.length)}</span>{text.slice(i + q.length)}</>;
}

/** The open palette. Deliberately a component of its own, mounted only while the palette is open, for two
 *  reasons that both come from `useDialogOverlay`: it captures the element to return focus to on its FIRST
 *  render, and it registers on the overlay stack in its first effect. Hosting that hook in the always-
 *  mounted `CommandPalette` would capture `document.body` at app start and restore focus to nothing.
 *
 *  It is also portaled to <body>, like `Modal` and `WorkspaceTakeover`. That is not cosmetic either:
 *  `overlayStack` isolates the background by marking every CHILD OF BODY except the overlay root `inert`,
 *  so an overlay rendered inside the shell tree would have its own body-level ancestor made inert and
 *  would blank itself out. */
function CommandPaletteDialog({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const { t } = useTranslation();
  // Query and cursor live HERE, so closing the palette discards them with the component and the next
  // open starts from an empty field without a reset effect flashing the previous search first.
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  // Focus trap, background isolation, body scroll lock, Escape and focus restore — the same contract
  // every other overlay in the app has. The input carries `data-autofocus`, which is what the hook
  // honours instead of focusing the panel itself.
  useDialogOverlay({ enabled: true, rootRef: layerRef, dialogRef: panelRef, onClose });

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => { if (active >= results.length) setActive(0); }, [results.length, active]);
  // The list scrolls, and Arrow navigation wraps, so the active row is routinely outside the visible
  // window — most obviously the moment Up from the first row lands on the last.
  useEffect(() => { optionRefs.current[active]?.scrollIntoView({ block: 'nearest' }); }, [active, results.length]);

  // Wraparound matches `SelectMenu`, the app's reference listbox: it moves modulo the option count rather
  // than stopping at the ends.
  const move = (delta: number) => {
    if (results.length === 0) return;
    setActive((i) => (i + delta + results.length) % results.length);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(Math.max(0, results.length - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); results[active]?.run(); }
  };

  return createPortal(
    <div
      ref={layerRef}
      className="overlay-layer-modal fixed inset-0 flex items-start justify-center bg-bg/70 p-4 pt-[12dvh]"
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t.common.openCommandPalette}
        tabIndex={-1}
        className="animate-pop-in w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface focus:outline-none"
        style={{ boxShadow: 'var(--shadow-raised)' }}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search size={16} className="shrink-0 text-text-muted" aria-hidden />
          <input
            data-autofocus
            role="combobox"
            aria-label={t.common.searchCommands}
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-controls={listId}
            aria-expanded={results.length > 0}
            aria-activedescendant={results.length > 0 ? optionId(active) : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t.common.searchCommands}
            className="h-12 w-full bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none"
          />
        </div>
        {/* The rows are `role="option"` on the buttons themselves, as in `SelectMenu`, but held out of the
            Tab cycle: focus stays in the combobox and the active row is announced through
            `aria-activedescendant`. The <li> wrappers are presentational so the listbox owns options only. */}
        <ul id={listId} role="listbox" aria-label={t.common.searchCommands} className="max-h-[50dvh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <li role="presentation" className="px-3 py-6 text-center text-sm text-text-muted">{t.common.noCommands}</li>
          ) : results.map((c, i) => {
            const Icon = c.icon;
            return (
              <li key={c.id} role="presentation">
                <button
                  id={optionId(i)}
                  ref={(node) => { optionRefs.current[i] = node; }}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => c.run()}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${i === active ? 'bg-elevated text-text' : 'text-text-muted'}`}
                >
                  <Icon size={15} className="shrink-0" aria-hidden />
                  <span className="flex-1 text-text"><Highlight text={c.label} q={query.trim()} /></span>
                  {c.hint ? <span className="font-mono text-[11px] text-text-muted">{c.hint}</span> : null}
                  {i === active ? <CornerDownLeft size={13} className="text-text-muted" aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body,
  );
}

export function CommandPalette() {
  const router = useRouter();
  const { t, locale } = useTranslation();
  const pluginUi = usePluginUi(locale);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Escape is deliberately NOT handled here: while the palette is open the overlay stack owns it, and
    // only for the TOPMOST overlay — so a dialog raised from a command dismisses itself first.
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((v) => !v); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    };
  }, []);

  const commands = useMemo<Command[]>(() => {
    const go = (route: string) => () => { router.push(route); setOpen(false); };
    const nav = MODULES.map((m) => ({ id: `nav:${m.route}`, label: `${t.common.goTo} ${t.page[m.id as keyof typeof t.page] ?? m.label}`, hint: m.route, icon: m.icon, run: go(m.route) }));
    // One entry per plugin PAGE (a world with sub-items contributes each of them), already localized
    // by the daemon's listing.
    const pluginNav = pluginNavEntries(pluginUi.data ?? [])
      .flatMap<{ href?: string; label: string; icon?: LucideIcon }>((world) => world.subItems ?? [world])
      .flatMap((entry) => entry.href && entry.icon
        ? [{ id: `nav:${entry.href}`, label: `${t.common.goTo} ${entry.label}`, hint: entry.href, icon: entry.icon, run: go(entry.href) }]
        : []);
    return [...nav, ...pluginNav];
  }, [router, t, pluginUi.data]);

  if (!open) return null;
  return <CommandPaletteDialog commands={commands} onClose={() => setOpen(false)} />;
}
