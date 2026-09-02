'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { CornerDownLeft } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { usePluginUi } from '../../lib/queries';
import { buildSearchIndex, filterEntries, findNormalizedRange, SEARCH_GROUP_ORDER, type SearchEntry, type SearchGroup } from './siteSearch';
import { focusOverlaySurface, useOverlayIsolation } from '../ui/overlayStack';
import { Dialog, DialogContent, DialogOverlay } from '../ui/shadcn/dialog';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '../ui/shadcn/command';

export const COMMAND_PALETTE_OPEN_EVENT = 'elowen:open-command-palette';

/** Accent-highlight the matched query substring within a label. The match is diacritics-insensitive —
 *  `retenc` highlights "Retence" — because it goes through the index's NFD normalizer, which maps the
 *  hit back onto the ORIGINAL string so the accented characters are the ones that colour. */
function Highlight({ text, q }: { text: string; q: string }) {
  const range = q.trim() ? findNormalizedRange(text, q) : null;
  if (!range) return <>{text}</>;
  const [start, end] = range;
  return <>{text.slice(0, start)}<span className="text-primary">{text.slice(start, end)}</span>{text.slice(end)}</>;
}

/** Group headings are reuses of names the app already prints — the rail's, the Settings deck's, the
 *  account deck's and the plugin group's — so the palette coins no second copy of any of them. */
function headingFor(t: ReturnType<typeof useTranslation>['t'], group: Exclude<SearchGroup, 'actions'>): string {
  if (group === 'pages') return t.common.primaryNav;
  if (group === 'settings') return t.page.settings;
  if (group === 'account') return t.account.title;
  return t.settings.plugins;
}

/** The open palette: the shadcn `Dialog` (and therefore Radix) wrapped around the shadcn `Command`
 *  (cmdk) searching the whole site.
 *
 *  THE DIALOG IS RADIX'S, exactly as in `Modal` — the focus trap, Tab looping, `role="dialog"`, Escape and
 *  the layer stack that decides which of several open overlays Escape belongs to, so a dialog raised FROM
 *  a command dismisses itself before this one. The app keeps only what Radix has no notion of: the overlay
 *  stack's `inert` isolation and scroll lock (`useOverlayIsolation`), which element takes focus on open and
 *  which gets it back on close, and the backdrop press. See `Modal.tsx` for why each of those is declined
 *  from Radix rather than merely reimplemented.
 *
 *  THE COMBOBOX IS CMDK'S. The roving cursor and its wraparound (`loop`), Home/End, Enter and the
 *  `combobox`/`listbox`/`option` ARIA wiring are the primitive's; filtering is the app's (`shouldFilter=
 *  {false}` + `filterEntries`, diacritics-insensitive), as is grouping, the highlight and the routing.
 *  The rows come from `lib/siteSearch.ts` — pages, the Settings and Account decks and their static rows,
 *  and plugin pages — never from a second copy of any label.
 *
 *  Mounted only while the palette is open, like every overlay here: `useOverlayIsolation` captures the
 *  element to return focus to on its FIRST render, so a component that stayed mounted while closed would
 *  capture whatever happened to be focused at app start and restore focus to nothing.
 *
 *  It is also portaled to <body>, like `Modal` and `WorkspaceTakeover`. That is not cosmetic either:
 *  `overlayStack` isolates the background by marking every CHILD OF BODY except the overlay root `inert`,
 *  so an overlay rendered inside the shell tree would have its own body-level ancestor made inert and
 *  would blank itself out. The cmdk parts render INSIDE this dialog — they have no portal of their own,
 *  which is exactly why the shadcn `CommandDialog` is not used (see `command.tsx`). */
function CommandPaletteDialog({ entries, onClose }: { entries: SearchEntry[]; onClose: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  // Query lives HERE, so closing the palette discards it with the component and the next open starts
  // from an empty field without a reset effect flashing the previous search first.
  const [query, setQuery] = useState('');
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Whether the press that is about to produce a click started on the backdrop itself. */
  const pressedBackdrop = useRef(false);

  // Background isolation, body scroll lock and the element to hand focus back to. The focus trap and
  // Escape are Radix's now; running both would mean two implementations answering the same Tab.
  const { restoreFocus } = useOverlayIsolation({ enabled: true, rootRef: layerRef });

  // The empty query is a calm launcher: pages plus the Settings and Account decks' SECTIONS only —
  // a section entry's id is `settings:<id>` / `account:<id>`, a row's carries the row path after it.
  // Typing is what reveals the rows (and the plugin pages). cmdk is handed `shouldFilter={false}`:
  // what is rendered IS the filtered list, so the list is a pure function of the query.
  const showRows = query.trim().length > 0;
  const isLauncherEntry = (entry: SearchEntry): boolean =>
    !entry.id.slice(entry.group.length + 1).includes(':');
  const matching = filterEntries(entries, query).filter((entry) => showRows || isLauncherEntry(entry));
  const visibleGroups = (showRows ? SEARCH_GROUP_ORDER : (['pages', 'settings', 'account'] as const))
    .filter((group): group is Exclude<SearchGroup, 'actions'> => group !== 'actions')
    .map((group) => ({ group, heading: headingFor(t, group), entries: matching.filter((entry) => entry.group === group) }))
    .filter(({ entries: groupEntries }) => groupEntries.length > 0);

  const run = (entry: SearchEntry | undefined) => {
    if (!entry) return;
    router.push(entry.href);
    onClose();
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
          {/* cmdk owns the roving cursor, its wraparound, Home/End, Enter and the ARIA; the app owns
              grouping, filtering (diacritics-insensitive, see `filterEntries`), highlighting and
              routing. The input row keeps the launcher's height; the panel is the focus indication, so
              the field itself drops the global focus halo (primitives.css, `.command-palette-search`). */}
          <Command
            loop
            shouldFilter={false}
            label={t.common.searchCommands}
            className="h-auto w-full bg-transparent [&_[data-slot=command-input-wrapper]]:h-12 [&_[data-slot=command-input-wrapper]]:px-4 [&_[data-slot=command-input-wrapper]]:gap-2.5"
          >
            <CommandInput
              data-autofocus
              value={query}
              onValueChange={setQuery}
              aria-label={t.common.searchCommands}
              placeholder={t.common.searchSite}
              className="command-palette-search h-12 w-full bg-transparent px-0 text-sm text-foreground placeholder:text-muted-foreground"
            />
            <CommandList label={t.common.searchCommands} className="max-h-[50dvh] p-1.5">
              <CommandEmpty className="px-3 py-6 text-center text-sm text-muted-foreground">{t.common.searchNoResults}</CommandEmpty>
              {visibleGroups.map(({ group, heading, entries: groupEntries }) => (
                <CommandGroup key={group} heading={<span className="uppercase tracking-wider">{heading}</span>}>
                  {groupEntries.map((entry) => {
                    const Icon = entry.icon;
                    return (
                      <CommandItem
                        key={entry.id}
                        value={entry.id}
                        onSelect={(value) => run(entries.find((candidate) => candidate.id === value))}
                        className="group rounded-md gap-3 px-3 py-2"
                      >
                        {Icon ? <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden /> : null}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-foreground"><Highlight text={entry.title} q={query} /></span>
                          {entry.subtitle ? (
                            <span className="block truncate text-xs text-muted-foreground"><Highlight text={entry.subtitle} q={query} /></span>
                          ) : null}
                        </span>
                        {/* The route / deep-link is today's hint column, mono as it always was. */}
                        <CommandShortcut className="font-mono text-[11px] tracking-normal">{entry.href}</CommandShortcut>
                        <CornerDownLeft size={13} className="shrink-0 text-muted-foreground opacity-0 group-data-[selected=true]:opacity-100" aria-hidden />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </DialogContent>
      </DialogOverlay>
    </Dialog>,
    document.body,
  );
}

export function CommandPalette() {
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

  // One index for the whole site, rebuilt while the palette is open (or about to open). `t` arrives
  // brand-resolved from useTranslation, so the index's `{agentName}` strings are display-ready.
  const entries = useMemo(
    () => buildSearchIndex(t, pluginUi.data ?? []),
    [t, pluginUi.data],
  );

  if (!open) return null;
  return <CommandPaletteDialog entries={entries} onClose={() => setOpen(false)} />;
}