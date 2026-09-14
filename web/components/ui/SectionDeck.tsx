'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Search, type LucideIcon } from 'lucide-react';
import { HelpTip } from './HelpTip';
import { revealHorizontalItem } from './horizontalScroll';
import { interpolate, useTranslation } from '../../lib/i18n';

/** A SECTION DECK: a page that is a set of named sections addressed by `?cat=`, read one at a time with
 *  its own way between them. `/settings` and `/account` are both one, and they are presented in the same
 *  page overlay (`components/ui/PageOverlay.tsx`), so everything about the frame and the navigation
 *  inside it is stated ONCE here rather than twice in two views that drifted apart — a 15rem column
 *  beside an 18rem one, a searchable list beside an unsearchable one, two paddings, two row heights.
 *
 *  What a deck still owns is what only it knows: which sections exist, where each one is addressed, and
 *  what a search over its own rows matches. Those arrive as `groups`. */

/** A row inside a section that a query matched, offered as its own way in. */
interface DeckNavMatch {
  id: string;
  label: string;
  onActivate: () => void;
}

/** One destination in the deck's navigation. */
interface DeckNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The section's own sentence, behind the shared help affordance rather than as a truncated subtitle. */
  hint?: string;
  /** Whether this is the section on screen. A destination that LEAVES the deck (a plugin's own page) is
   *  never current, because the deck is not what it opens. */
  current?: boolean;
  onActivate: () => void;
  /** Matching rows, each addressable on its own. */
  matches?: DeckNavMatch[];
  /** Matching material that is NOT addressable from here — a plugin deck's inner sections — shown as one
   *  quiet line of context under the record instead of as controls that would go to the same place. */
  matchSummary?: string;
}

/** A named list within the navigation. Captions and spacing separate the lists; a horizontal rule made
 *  the second one read as a footnote under the first. */
export interface DeckNavGroup {
  id: string;
  caption?: string;
  items: DeckNavItem[];
}

/** ONE navigation record: the leading glyph, the name and the shared help affordance.
 *
 *  DENSITY. The record is a 2rem row — the height this app's own primary sidebar row uses, and the one
 *  the reference secondary navigation uses — and grows to the `--touch-target` floor for a COARSE
 *  POINTER. Pointer capability, not a viewport width: a tablet with a finger is wide enough for the
 *  column and still reaches it by touch, so a `md:` breakpoint would have handed exactly that device the
 *  compact mouse rhythm. This is the app's established idiom, stated the same way `Pager`,
 *  `RegisterSearch` and `.sidebar-nav__sub-item` state it.
 *
 *  The icon is a plain 1rem glyph held at half opacity, exactly as `.sidebar-nav__icon` holds one: the
 *  boxed 2rem badge that used to lead each record made the column read as a list of buttons and cost the
 *  list a third of its height. The trailing chevron went with it — it pointed at nothing a vertical
 *  navigation does not already say, and the record's own fill is what marks which section is open.
 *
 *  The activating control is a button STRETCHED over the record rather than one wrapping it (the idiom
 *  `.data-table-row-open` uses for the same reason). A HelpTip is itself a button, and a button inside a
 *  button is markup no browser treats as two controls: the help would be unreachable from the keyboard
 *  and pressing it would navigate. Stretched, the record keeps one tab stop, the help keeps its own, and
 *  the help — positioned, and after the stretched control in DOM — takes its own pointer events, so
 *  revealing it never navigates. The help carries its OWN 24x24 hit area (see `HelpTip`), because a 16px
 *  mark floating over a full-width navigation control turns every near miss into a navigation, and it is
 *  named after the record it belongs to rather than being the twelfth button called "Help". */
function DeckNavRow({ label, hint, icon: Icon, current = false, onActivate }: DeckNavItem) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <div className={`relative flex h-8 items-center gap-2.5 rounded-lg px-2 transition-colors hover:bg-accent pointer-coarse:min-h-[var(--touch-target)] ${current ? 'bg-accent' : ''}`}>
      <button
        type="button"
        aria-labelledby={labelId}
        aria-current={current ? 'page' : undefined}
        onClick={onActivate}
        className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      />
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-foreground opacity-50" aria-hidden>
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <span id={labelId} className="min-w-0 truncate text-sm font-medium text-foreground">{label}</span>
      {hint ? <HelpTip align="left" label={interpolate(t.common.helpFor, { label })}>{hint}</HelpTip> : null}
    </div>
  );
}

/** The deck's section navigation, in the two shapes the two viewports have room for.
 *
 *  `sidebar` is the searchable secondary column, where there is width for one. Its search filters the
 *  rows the deck handed in; the deck builds those from the same static index the command palette uses, so
 *  typed field values, fetched secrets and transient status text are never searchable here.
 *
 *  `tabs` is the phone's answer: one line of sections above the content, scrolled sideways with a thumb.
 *  It replaced a master/detail pane switch, which hid the section the reader had just opened behind a
 *  "back" step and made moving between two sections a four-tap round trip. The strip carries no search
 *  field — it is a way BETWEEN places, and a filter box belongs with the column that has room to show
 *  what it filtered — and it is never a select menu, which hides every destination but one. */
export function DeckNavigation({ label, groups, layout, testId, search, emptyLabel, className = '' }: {
  /** Accessible name of the navigation region. */
  label: string;
  groups: DeckNavGroup[];
  layout: 'sidebar' | 'tabs';
  /** Prefix for the two surfaces' test ids: `<testId>-sidebar` and `<testId>-tabs`. */
  testId: string;
  /** The column's filter. A deck without one renders no field; both decks have one. */
  search?: { value: string; onChange: (value: string) => void; label: string };
  /** What the column says when the query matches nothing. */
  emptyLabel: string;
  className?: string;
}) {
  const tabs = layout === 'tabs';
  const trackRef = useRef<HTMLElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const items = groups.flatMap((group) => group.items);

  /** Keep the section on screen visible on the phone's one line.
   *
   *  The strip is narrower than its own contents, so a section near the end — the terminal, or whatever a
   *  plugin contributes — is off to the right until it is scrolled to. Arriving on it through a deep link,
   *  the command palette or a remembered section would otherwise show a tab row with nothing marked in it.
   *
   *  `revealHorizontalItem` is the shared idiom (components/ui/horizontalScroll.ts): it moves the track's
   *  own `scrollLeft` by the measured shortfall, so no ancestor scroller is asked to move the page
   *  vertically and there is no animation for a reduced-motion preference to have an opinion about.
   *
   *  Keyed on what the strip SHOWS rather than on the arrays it was handed: both are rebuilt on every
   *  render, while a plugin's section arrives from a live query a commit later. */
  const stripKey = items.map((item) => item.id).join('\u0001');
  const activeKey = items.find((item) => item.current)?.id ?? '';
  useEffect(() => {
    if (!tabs) return;
    const track = trackRef.current;
    const item = activeItemRef.current;
    if (!track || !item) return;
    revealHorizontalItem(track, item);
  }, [activeKey, stripKey, tabs]);

  if (tabs) {
    return (
      <nav
        ref={trackRef}
        aria-label={label}
        data-testid={`${testId}-tabs`}
        className={`section-deck-strip flex shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain whitespace-nowrap pb-2 ${className}`}
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              ref={item.current ? activeItemRef : undefined}
              type="button"
              aria-current={item.current ? 'page' : undefined}
              onClick={item.onActivate}
              className={`section-deck-strip__tab flex h-8 shrink-0 select-none items-center gap-2 rounded-full px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                item.current ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              <Icon size={14} strokeWidth={1.75} aria-hidden className={item.current ? 'text-primary' : undefined} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
      {search ? (
        <label className="relative block shrink-0 p-3">
          <span className="sr-only">{search.label}</span>
          <Search className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} aria-hidden />
          <input
            type="search"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.label}
            className="h-8 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 pointer-coarse:h-[var(--touch-target)]"
          />
        </label>
      ) : null}
      {/* The column's own inset is 0.75rem and a record's is 0.5rem, so a label starts 1.25rem from the
          column edge — the inset the reference navigation uses, and the one that keeps a record's fill
          reading as a pill inside the column rather than as a full-bleed band. */}
      <nav aria-label={label} data-testid={`${testId}-sidebar`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        <div className="flex flex-col gap-0.5">
          {groups.filter((group) => group.items.length > 0).map((group, index) => (
            <div key={group.id} className={index > 0 ? 'mt-3' : undefined}>
              {group.caption ? <p className="px-2 pb-1 text-xs text-muted-foreground">{group.caption}</p> : null}
              {group.items.map((item) => (
                <div key={item.id}>
                  <DeckNavRow {...item} />
                  {item.matches && item.matches.length > 0 ? (
                    <div className="mb-2 ml-4 flex flex-col border-l border-border pl-3">
                      {item.matches.map((match) => (
                        <button
                          key={match.id}
                          type="button"
                          onClick={match.onActivate}
                          className="rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          {match.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {item.matchSummary ? (
                    <p className="mb-2 ml-4 border-l border-border px-3 py-1 text-xs leading-5 text-muted-foreground">{item.matchSummary}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
          {items.length === 0 ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p> : null}
        </div>
      </nav>
    </div>
  );
}

/** THE DECK'S FRAME: the secondary column beside the content where there is width for it, the single line
 *  of tabs above the content on a phone, and the one content pane that scrolls.
 *
 *  The 15rem column is the measure: every navigation record is one line, and the longest localized
 *  section name fits inside it, so a wider column is empty column taken from the content beside it. The
 *  breakpoint is `md`, which is where the overlay itself stops being the phone's full screen.
 *
 *  The content pane is the ONE scroller — the column scrolls on its own inside the aside, the strip
 *  scrolls sideways, and nothing nests a second vertical scroll inside the screen the reader is already
 *  scrolling. */
export function SectionDeck({ testId, contentLabel, navigation, children }: {
  /** Addresses the deck's grid from a test. */
  testId: string;
  /** Accessible name of the content region: the section on screen. */
  contentLabel: string;
  /** The deck's own navigation, in the shape the frame asks for. */
  navigation: (layout: 'sidebar' | 'tabs', className?: string) => ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId} className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="hidden min-h-0 flex-col border-border md:flex md:border-r">
        {navigation('sidebar')}
      </aside>
      <section
        role="region"
        aria-label={contentLabel}
        className="flex min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain p-3 md:px-6 md:pb-4 md:pt-3"
      >
        {navigation('tabs', 'md:hidden')}
        {children}
      </section>
    </div>
  );
}
