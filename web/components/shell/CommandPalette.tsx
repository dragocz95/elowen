'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { CornerDownLeft, Sparkles } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { usePluginUi } from '../../lib/queries';
import { elowenClient } from '../../lib/elowenClient';
import {
  askCandidates, buildSearchIndex, filterEntries, findNormalizedRange, rankCandidates,
  SEARCH_GROUP_ORDER, SEARCH_MAX_QUERY_CHARS, type SearchEntry, type SearchGroup,
} from './siteSearch';
import { focusOverlaySurface, useOverlayIsolation } from '../ui/overlayStack';
import { Spinner } from '../ui/states';
import { Dialog, DialogContent, DialogOverlay } from '../ui/shadcn/dialog';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '../ui/shadcn/command';

export const COMMAND_PALETTE_OPEN_EVENT = 'elowen:open-command-palette';

/** How long typing has to settle before the semantic pass costs an embedding call. The lexical filter
 *  stays instant — it runs locally on every keystroke — so this delay is never felt as latency on the
 *  answer the user is most likely waiting for. */
const SEMANTIC_DEBOUNCE_MS = 300;

/** The gate on the semantic pass. Below three characters a query is a prefix, not a question, and the
 *  lexical filter answers prefixes better than any embedding does; at three or more lexical hits the
 *  user already has what they came for and a second opinion is noise. So the network is only ever
 *  touched for a real query that the literal search could not satisfy. */
const SEMANTIC_MIN_QUERY_CHARS = 3;
const SEMANTIC_LEXICAL_FLOOR = 3;

/** The Ask row's cmdk value. Prefixed so it cannot collide with a `SearchEntry` id, which is always
 *  `<group>:<something>`. */
const ASK_ITEM_VALUE = '__ask-ai__';

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

/** ONE row anatomy, used by the lexical groups and by the suggestion group alike: icon, title, subtitle,
 *  the route in the hint column, the Enter glyph on the cursor. `q` is the query to highlight within the
 *  labels — the suggestion group passes none, because nothing there matched literally and painting an
 *  accent on an arbitrary substring would claim a match that does not exist. */
function EntryRow({ entry, q, onRun }: { entry: SearchEntry; q?: string; onRun: (id: string) => void }) {
  const Icon = entry.icon;
  return (
    <CommandItem
      value={entry.id}
      onSelect={onRun}
      className="group rounded-md gap-3 px-3 py-2"
    >
      {Icon ? <Icon size={15} className="shrink-0 text-muted-foreground" aria-hidden /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{q ? <Highlight text={entry.title} q={q} /> : entry.title}</span>
        {entry.subtitle ? (
          <span className="block truncate text-xs text-muted-foreground">{q ? <Highlight text={entry.subtitle} q={q} /> : entry.subtitle}</span>
        ) : null}
      </span>
      {/* The route / deep-link is today's hint column, mono as it always was. */}
      <CommandShortcut className="font-mono text-[11px] tracking-normal">{entry.href}</CommandShortcut>
      <CornerDownLeft size={13} className="shrink-0 text-muted-foreground opacity-0 group-data-[selected=true]:opacity-100" aria-hidden />
    </CommandItem>
  );
}

/** The state of the one-shot "Ask AI" request. An ask that legitimately found nothing lands back on
 *  `idle` with no entries — i.e. on the empty state, offering to ask again — rather than on a heading
 *  with nothing under it. */
type AskState = { status: 'idle' | 'pending' | 'error'; entries: SearchEntry[] };
/** Shared constants, not fresh literals: `setState` bails out on an identical value, so clearing a
 *  result that is already clear costs no render. */
const NO_ENTRIES: SearchEntry[] = [];
const ASK_IDLE: AskState = { status: 'idle', entries: NO_ENTRIES };

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
 *  SEARCH HAPPENS IN THREE PASSES, each only reached when the one before it came up short. The lexical
 *  filter is local and instant. Below three lexical hits, `POST /search/rank` ranks the SAME index by
 *  meaning, so "nastavení tahů max" reaches "Maximum kroků" with no word in common; its rows land in a
 *  separate group because they carry no literal match to highlight. With nothing at all, one explicit
 *  click asks a model. Every layer degrades to silence: an instance with no embedding provider answers
 *  503, the layer switches itself off for the rest of the palette session, and the user is never told
 *  about a capability this install does not have.
 *
 *  Mounted only while the palette is open, like every overlay here: `useOverlayIsolation` captures the
 *  element to return focus to on its FIRST render, so a component that stayed mounted while closed would
 *  capture whatever happened to be focused at app start and restore focus to nothing. It is also what
 *  scopes the two pieces of session state above — the disabled flag and the ask result — to one opening.
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
  const [semantic, setSemantic] = useState<SearchEntry[]>(NO_ENTRIES);
  const [ask, setAsk] = useState<AskState>(ASK_IDLE);
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Whether the press that is about to produce a click started on the backdrop itself. */
  const pressedBackdrop = useRef(false);
  /** Set once the daemon has said it cannot rank (no embedding provider, or the provider is down). One
   *  refusal is enough: nothing about it will change while this palette is open, and asking again on
   *  every keystroke would be a stream of failing requests nobody would ever see the result of. */
  const semanticOff = useRef(false);
  /** Monotonic id of the newest ranking request. A response carrying an older id is a stale answer to a
   *  query the user has already moved past — dropped rather than rendered. The AbortController below
   *  usually prevents it from arriving at all; this is what makes "usually" not matter. */
  const rankRequest = useRef(0);
  const askAbort = useRef<AbortController | null>(null);

  // Background isolation, body scroll lock and the element to hand focus back to. The focus trap and
  // Escape are Radix's now; running both would mean two implementations answering the same Tab.
  const { restoreFocus } = useOverlayIsolation({ enabled: true, rootRef: layerRef });

  // The empty query is a calm launcher: pages plus the Settings and Account decks' SECTIONS only —
  // a section entry's id is `settings:<id>` / `account:<id>`, a row's carries the row path after it.
  // Typing is what reveals the rows (and the plugin pages). cmdk is handed `shouldFilter={false}`:
  // what is rendered IS the filtered list, so the list is a pure function of the query.
  const trimmed = query.trim();
  const showRows = trimmed.length > 0;
  const isLauncherEntry = (entry: SearchEntry): boolean =>
    !entry.id.slice(entry.group.length + 1).includes(':');
  const matching = filterEntries(entries, query).filter((entry) => showRows || isLauncherEntry(entry));
  const visibleGroups = (showRows ? SEARCH_GROUP_ORDER : (['pages', 'settings', 'account'] as const))
    .filter((group): group is Exclude<SearchGroup, 'actions'> => group !== 'actions')
    .map((group) => ({ group, heading: headingFor(t, group), entries: matching.filter((entry) => entry.group === group) }))
    .filter(({ entries: groupEntries }) => groupEntries.length > 0);

  const lexicalIds = new Set(matching.map((entry) => entry.id));
  // Whatever the two assisted passes produced, minus anything the lexical list already shows — a row
  // repeated under a second heading reads as two destinations.
  const suggestions = [...semantic, ...ask.entries]
    .filter((entry, i, all) => !lexicalIds.has(entry.id) && all.findIndex((other) => other.id === entry.id) === i);

  const wantSemantic = showRows
    && trimmed.length >= SEMANTIC_MIN_QUERY_CHARS
    && matching.length < SEMANTIC_LEXICAL_FLOOR;

  /** Map returned ids back onto real index rows. Both endpoints answer with ids from the list they were
   *  given, so an id that resolves to nothing here is a mismatch worth dropping, never worth guessing. */
  const resolve = useCallback((hits: { id: string }[]): SearchEntry[] => {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return hits.flatMap((hit) => { const entry = byId.get(hit.id); return entry ? [entry] : []; });
  }, [entries]);

  // The semantic pass. Debounced, cancelled on every keystroke, and silent about every failure.
  useEffect(() => {
    if (!wantSemantic || semanticOff.current) {
      setSemantic(NO_ENTRIES);
      return;
    }
    const id = ++rankRequest.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      elowenClient.searchRank(trimmed.slice(0, SEARCH_MAX_QUERY_CHARS), rankCandidates(entries), controller.signal)
        .then(({ results }) => {
          if (id !== rankRequest.current) return; // a newer query has already been asked
          setSemantic(resolve(results));
        })
        .catch(() => {
          // An abort is this effect's own cleanup, not a failure — it must not disable the layer.
          if (controller.signal.aborted) return;
          semanticOff.current = true;
          if (id === rankRequest.current) setSemantic(NO_ENTRIES);
        });
    }, SEMANTIC_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [wantSemantic, trimmed, entries, resolve]);

  // A new query is a new question: whatever the assistant answered about the previous one is gone, and
  // an in-flight ask is abandoned rather than allowed to land on a list it no longer describes.
  useEffect(() => {
    askAbort.current?.abort();
    askAbort.current = null;
    setAsk(ASK_IDLE);
  }, [trimmed]);
  // The palette can close mid-ask; nothing should still be in flight for a surface that is gone.
  useEffect(() => () => askAbort.current?.abort(), []);

  const runAsk = useCallback(() => {
    const controller = new AbortController();
    askAbort.current = controller;
    setAsk({ status: 'pending', entries: NO_ENTRIES });
    elowenClient.searchAsk(trimmed.slice(0, SEARCH_MAX_QUERY_CHARS), askCandidates(entries), controller.signal)
      .then(({ results }) => {
        if (controller.signal.aborted) return;
        setAsk({ status: 'idle', entries: resolve(results) });
      })
      .catch(() => {
        // Deliberately not a toast: the palette is a transient overlay and the failure belongs inside it,
        // where the question was asked, not on the page underneath it.
        if (!controller.signal.aborted) setAsk({ status: 'error', entries: NO_ENTRIES });
      });
  }, [trimmed, entries, resolve]);

  const run = (id: string) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    router.push(entry.href);
    onClose();
  };

  // Nothing to offer at all: the empty state, plus the one row that can still do something about it.
  const isEmpty = showRows && visibleGroups.length === 0 && suggestions.length === 0;

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
              {/* Not cmdk's `CommandEmpty`: that hides itself the moment ANY item is mounted, and the
                  empty state here deliberately carries one — the row that asks the assistant. */}
              {isEmpty ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t.common.searchNoResults}</div>
              ) : null}
              {visibleGroups.map(({ group, heading, entries: groupEntries }) => (
                <CommandGroup key={group} heading={<span className="uppercase tracking-wider">{heading}</span>}>
                  {groupEntries.map((entry) => <EntryRow key={entry.id} entry={entry} q={query} onRun={run} />)}
                </CommandGroup>
              ))}
              {suggestions.length > 0 ? (
                <CommandGroup heading={<span className="uppercase tracking-wider">{t.common.searchSuggestions}</span>}>
                  {suggestions.map((entry) => <EntryRow key={entry.id} entry={entry} onRun={run} />)}
                </CommandGroup>
              ) : null}
              {isEmpty && ask.status !== 'error' ? (
                <CommandItem
                  value={ASK_ITEM_VALUE}
                  disabled={ask.status === 'pending'}
                  aria-busy={ask.status === 'pending'}
                  onSelect={runAsk}
                  className="rounded-md gap-3 px-3 py-2"
                >
                  {ask.status === 'pending'
                    ? <Spinner size="sm" />
                    : <Sparkles size={15} className="shrink-0 text-muted-foreground" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {t.common.searchAskAi.replace('{query}', trimmed)}
                  </span>
                </CommandItem>
              ) : null}
              {isEmpty && ask.status === 'error' ? (
                <div className="px-3 pb-4 text-center text-sm text-muted-foreground">{t.common.searchAskFailed}</div>
              ) : null}
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
