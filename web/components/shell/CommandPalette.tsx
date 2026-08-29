'use client';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Search, CornerDownLeft, type LucideIcon } from 'lucide-react';
import { MODULES } from '../../modules/registry';
import { useTranslation } from '../../lib/i18n';
import { usePluginUi } from '../../lib/queries';
import { pluginNavEntries } from '../../lib/pluginNav';
import { focusOverlaySurface, useOverlayIsolation } from '../ui/overlayStack';
import { Dialog, DialogContent, DialogOverlay } from '../ui/shadcn/dialog';

interface Command { id: string; label: string; hint?: string; icon: LucideIcon; run: () => void }

export const COMMAND_PALETTE_OPEN_EVENT = 'elowen:open-command-palette';

/** Accent-highlight the matched query substring within a label. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<span className="text-primary">{text.slice(i, i + q.length)}</span>{text.slice(i + q.length)}</>;
}

/** The open palette: the shadcn `Dialog` (and therefore Radix) wrapped around a combobox of commands.
 *
 *  THE DIALOG IS RADIX'S, exactly as in `Modal` — the focus trap, Tab looping, `role="dialog"`, Escape and
 *  the layer stack that decides which of several open overlays Escape belongs to, so a dialog raised FROM a
 *  command dismisses itself before this one. The app keeps only what Radix has no notion of: the overlay
 *  stack's `inert` isolation and scroll lock (`useOverlayIsolation`), which element takes focus on open and
 *  which gets it back on close, and the backdrop press. See `Modal.tsx` for why each of those is declined
 *  from Radix rather than merely reimplemented.
 *
 *  THE COMBOBOX IS THE APP'S. Radix has no combobox primitive, so the input's `role="combobox"`, the
 *  listbox and its options, and the Arrow/Home/End/Enter cursor below are authored here on purpose.
 *
 *  Mounted only while the palette is open, like every overlay here: `useOverlayIsolation` captures the
 *  element to return focus to on its FIRST render, so a component that stayed mounted while closed would
 *  capture whatever happened to be focused at app start and restore focus to nothing.
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
  /** Whether the press that is about to produce a click started on the backdrop itself. */
  const pressedBackdrop = useRef(false);

  // Background isolation, body scroll lock and the element to hand focus back to. The focus trap and
  // Escape are Radix's now; running both would mean two implementations answering the same Tab.
  const { restoreFocus } = useOverlayIsolation({ enabled: true, rootRef: layerRef });

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
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogOverlay
        ref={layerRef}
        presentation="center"
        // A launcher sits near the top of the viewport rather than in the middle of it, so the surface is
        // anchored to the start of the layer. The inline padding keeps the centered presentation's
        // safe-area insets; only the top one is replaced.
        className="items-start"
        style={{ paddingTop: 'max(12dvh, var(--safe-top))' }}
        // A backdrop dismissal has to be a press that BEGAN on the backdrop. `click` fires on the common
        // ancestor of the press and the release, so a press that starts inside the panel and ends out here
        // still arrives with `target === currentTarget` — and Radix Select makes that the normal case
        // rather than an edge one, since opening it puts `pointer-events: none` on <body>. See `Modal`.
        onPointerDown={(event) => { pressedBackdrop.current = event.target === event.currentTarget; }}
        onClick={(event) => {
          if (event.target !== event.currentTarget || !pressedBackdrop.current) return;
          pressedBackdrop.current = false;
          event.stopPropagation();
          onClose();
        }}
      >
        <DialogContent
          ref={panelRef}
          presentation="center"
          size="md"
          className="overflow-hidden"
          aria-label={t.common.openCommandPalette}
          style={{ boxShadow: 'var(--shadow-raised)' }}
          // Radix would otherwise dismiss on any press outside the surface, a second owner of the decision
          // the backdrop above already makes — and one that cannot tell the two presses apart.
          onInteractOutside={(event) => event.preventDefault()}
          // Focus policy stays the app's. Radix would focus the first tabbable control; this app anchors on
          // `[data-autofocus]` — the search field — and hands focus back to the opener on close, which
          // Radix cannot do because the palette is mounted on open rather than opened from a trigger.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (panelRef.current) focusOverlaySurface(panelRef.current);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <div className="flex items-center gap-2.5 border-b border-border px-4">
            <Search size={16} className="shrink-0 text-muted-foreground" aria-hidden />
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
              className="h-12 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
          {/* The rows are `role="option"` on the buttons themselves, as in `SelectMenu`, but held out of the
              Tab cycle: focus stays in the combobox and the active row is announced through
              `aria-activedescendant`. The <li> wrappers are presentational so the listbox owns options only. */}
          <ul id={listId} role="listbox" aria-label={t.common.searchCommands} className="max-h-[50dvh] overflow-y-auto p-1.5">
            {results.length === 0 ? (
              <li role="presentation" className="px-3 py-6 text-center text-sm text-muted-foreground">{t.common.noCommands}</li>
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
                    // The active row is a wash of the foreground (`accent`), not a step up the surface
                    // ramp: a skin may collapse that ramp — studio-oled paints surface, elevated and
                    // overlay the same near-black — and a highlight built from it disappears entirely.
                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${i === active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}
                  >
                    <Icon size={15} className="shrink-0" aria-hidden />
                    <span className="flex-1 text-foreground"><Highlight text={c.label} q={query.trim()} /></span>
                    {c.hint ? <span className="font-mono text-[11px] text-muted-foreground">{c.hint}</span> : null}
                    {i === active ? <CornerDownLeft size={13} className="text-muted-foreground" aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </DialogOverlay>
    </Dialog>,
    document.body,
  );
}

export function CommandPalette() {
  const router = useRouter();
  const { t, locale } = useTranslation();
  const pluginUi = usePluginUi(locale);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Escape is deliberately NOT handled here: while the palette is open its Radix dialog owns it, and
    // only for the TOPMOST layer — so a dialog raised from a command dismisses itself first.
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
