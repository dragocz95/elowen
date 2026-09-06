'use client';
import { Children, Fragment, isValidElement, useCallback, useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { HelpTip } from './HelpTip';
import { WorkspaceLeadPortal } from './WorkspaceShell';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './shadcn/collapsible';
import { usePersistentState } from '../../lib/usePersistentState';

type SettingsTone = 'default' | 'danger';
type SettingsDensity = 'comfortable' | 'compact';

/** Where a remembered fold lives. ONE namespace for every settings and account surface, so a group is
 *  identified by its own stable id and never by the page that happens to render it. Like every other UI
 *  preference in this app (`elowen.settings.category`, `elowen.memory.tab`, the chat and dock keys) it is
 *  per BROWSER rather than per user id: nothing here scopes a preference by account, and inventing a
 *  second convention for this one switch would be the drift rather than the fix. */
const GROUP_FOLD_PREFIX = 'elowen.settings.fold.';
const FOLD_STATES = ['open', 'closed'] as const;
type FoldState = (typeof FOLD_STATES)[number];

/** A settings or account page is a STACK OF SECTION CARDS, not one long bordered document. The shell
 *  `control-surface-document` would otherwise draw around the whole stack is dropped in CSS, so each
 *  group carries its own border and the gap between them does the separating. */
export function SettingsDocument({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div data-control-surface data-settings-document className={`control-surface-document settings-document ${className}`}>{children}</div>;
}

/** One section card: an accent-marked header (icon, title, optional description and actions) above a
 *  body of records.
 *
 *  `columns={2}` splits the records into two explicit stacks side by side, which keeps a six-row form on
 *  one screen instead of a column with half of it empty. The split happens HERE rather than in CSS
 *  because each stack has to be its own grid: the records inside one stack share their column tracks
 *  through subgrid, and that is what makes every status and every action line up. CSS multi-column would
 *  reflow the same rows into one box and take that alignment away.
 *
 *  `collapsible` folds the body under the header: the heading becomes ONE trigger button (the actions
 *  stay a sibling OUTSIDE it, so an action click can never toggle the group) and the chevron at its
 *  trailing edge states the fold. The body stays MOUNTED while closed — `hidden` on an always-rendered
 *  `CollapsibleContent forceMount` — so deep links and in-page search still find rows that are folded
 *  away, and a caller can force the group open through `open`/`onOpenChange`.
 *
 *  `storageKey` remembers the reader's own choice across reloads. It is the ONE mechanism for that: it
 *  wraps the controlled `open`/`onOpenChange` pair the component already had, so no page keeps fold state
 *  of its own and no two pages can drift on how they keep it. */
export type SettingsGroupProps = {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  actions?: ReactNode;
  tone?: SettingsTone;
  density?: SettingsDensity;
  columns?: 1 | 2;
  /** The anchor a deep link reveals this card by — see {@link SettingsRow}'s `rowId`. A GROUP carries one
   *  when the search index knows it by its header rather than by a record inside it: a card whose whole
   *  content is a viewer behind one button (Logs, Diagnostics) has no row to point at. */
  rowId?: string;
  /** Fold the body under the header. Closed by default (`defaultOpen`), or fully controlled through
   *  `open` + `onOpenChange` for callers that want to expand a group on the program's say-so. */
  collapsible?: boolean;
  /** Initial state of an uncontrolled collapsible group. Ignored (and defaults to closed) without
   *  `collapsible`. */
  defaultOpen?: boolean;
  /** Controlled fold state. Passing it disables the internal state, exactly like a controlled input. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A STABLE, locale-independent id under which this group's fold is remembered — `brain.providers`,
   *  `terminal.colors`. Only meaningful together with `collapsible`, and ignored when the caller drives
   *  `open` itself, because a controlled group already has an owner for that state. A remembered group
   *  starts open unless `defaultOpen={false}`. */
  storageKey?: string;
  /** Optional: a group whose whole story fits in its header (a title, a figure, one action) renders as a
   *  single row. An empty body div would still contribute its own padding and read as a stray gap. */
  children?: ReactNode;
  className?: string;
};

/** The dispatcher holds NO state of its own, which is what lets the persisted variant be a separate
 *  component and still obey the rules of hooks. */
export function SettingsGroup(props: SettingsGroupProps) {
  if (props.collapsible && props.storageKey && props.open === undefined) {
    return <PersistedSettingsGroup {...props} storageKey={props.storageKey} />;
  }
  return <SettingsGroupView {...props} />;
}

/** The remembered fold. `usePersistentState` is the app's one localStorage-backed state helper; it starts
 *  from the fallback and rehydrates inside an effect, so the server and the first client paint agree and
 *  a group that was left closed simply folds a tick later. A remembered group starts OPEN (owner decision,
 *  6 Sep 2026: a page reads fuller when nothing is hidden until the reader hides it) — `defaultOpen={false}`
 *  opts a group out. A deep link into a folded group still works unchanged: `useRowAnchor` clicks the
 *  trigger, the click lands here as `onOpenChange(true)`, and the group both opens and remembers that it
 *  did. */
function PersistedSettingsGroup({ storageKey, defaultOpen = true, onOpenChange, ...rest }: SettingsGroupProps & { storageKey: string }) {
  const [stored, setStored] = usePersistentState<FoldState>(`${GROUP_FOLD_PREFIX}${storageKey}`, defaultOpen ? 'open' : 'closed', FOLD_STATES);
  const handleOpenChange = useCallback((next: boolean) => {
    setStored(next ? 'open' : 'closed');
    onOpenChange?.(next);
  }, [onOpenChange, setStored]);
  return <SettingsGroupView {...rest} collapsible open={stored === 'open'} onOpenChange={handleOpenChange} />;
}

function SettingsGroupView({ title, description, icon: Icon, actions, tone = 'default', density = 'comfortable', columns = 1, rowId, collapsible = false, defaultOpen, open, onOpenChange, children, className = '' }: SettingsGroupProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;
  // Radix's trigger drops `aria-controls` while closed (its content is unmounted); ours is force-mounted
  // and merely `hidden`, so the pair must hold in BOTH states — hand in an id of our own.
  const contentId = useId();
  const setOpen = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  if (!collapsible) {
    return (
      <section data-settings-group data-tone={tone} data-density={density} data-row-id={rowId} className={`settings-group ${className}`}>
        {title || description || actions ? (
          <header className="settings-group__header">
            <div className="settings-group__heading">
              {Icon ? <span className="settings-group__icon" aria-hidden><Icon size={16} strokeWidth={1.75} /></span> : null}
              <div className="min-w-0">
                {title ? <h2>{title}</h2> : null}
                {description ? <p>{description}</p> : null}
              </div>
            </div>
            {actions ? <div className="settings-group__actions">{actions}</div> : null}
          </header>
        ) : null}
        {children ? <div className="settings-group__body" data-columns={columns}>{splitIntoColumns(children, columns)}</div> : null}
      </section>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setOpen} asChild>
      <section data-settings-group data-tone={tone} data-density={density} data-row-id={rowId} className={`settings-group ${className}`}>
        <header className="settings-group__header">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-controls={contentId}
              className="settings-group__trigger"
            >
              <div className="settings-group__heading">
                {Icon ? <span className="settings-group__icon" aria-hidden><Icon size={16} strokeWidth={1.75} /></span> : null}
                <div className="min-w-0">
                  {title ? <h2>{title}</h2> : null}
                  {description ? <p>{description}</p> : null}
                </div>
              </div>
              <ChevronRight className="settings-group__chevron" size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </CollapsibleTrigger>
          {actions ? <div className="settings-group__actions">{actions}</div> : null}
        </header>
        {/* Mounted even when closed: the body is what deep links and anchors point at, and search has
            to find text inside a folded group. Visibility (not existence) is the only thing that folds. */}
        {children ? (
          <CollapsibleContent forceMount id={contentId} hidden={!isOpen} className="settings-group__body" data-columns={columns}>
            {splitIntoColumns(children, columns)}
          </CollapsibleContent>
        ) : null}
      </section>
    </Collapsible>
  );
}

/** One stack, or two balanced ones. The first stack takes the extra record on an odd count, so a
 *  three-row form reads 2 + 1 top-down rather than leaving a gap in the left column. */
function splitIntoColumns(children: ReactNode, columns: 1 | 2): ReactNode {
  if (columns === 1) return children;
  const items = Children.toArray(children);
  if (items.length < 2) return children;
  const half = Math.ceil(items.length / 2);
  return (
    <>
      <div className="settings-group__column">{items.slice(0, half)}</div>
      <div className="settings-group__column">{items.slice(half)}</div>
    </>
  );
}

/** How many trailing actions a record may carry beside its control. Three is the ceiling because the
 *  trailing side is ONE line and icon-only actions are what a record carries (manage / settings /
 *  remove); anything more stops being a record and becomes a toolbar, which belongs in the section
 *  header where there is room for it. */
export const MAX_ROW_ACTIONS = 3;

/** Trailing slots in a node, counting THROUGH fragments. `Children.count` reports `<><A/><B/><C/></>`
 *  as one, which is the shape most call sites hand in, so counting without this would report every
 *  overloaded row as compliant. */
function countSlots(node: ReactNode): number {
  return Children.toArray(node).reduce<number>((total, child) => (
    isValidElement(child) && child.type === Fragment
      ? total + countSlots((child.props as { children?: ReactNode }).children)
      : total + 1
  ), 0);
}

/** A label/control record inside a section card, and the canonical anatomy every settings and account
 *  row is built from.
 *
 *  THE CONTRACT. A record is a label and ONE control, optionally a SHORT status and at most
 *  {@link MAX_ROW_ACTIONS} actions. On a wide card the whole thing is one grid row borrowed from the
 *  stack through subgrid; in a narrow container it folds to a two-line band — the label, its help and its
 *  status on the first line, the control and the actions on a second line that does not wrap. There
 *  is deliberately no third line: a record that needs one is carrying several values and should declare
 *  `trailingLayout="stack"`, which opts out of the band and gives each part the row's full width.
 *
 *  WHERE THE STATUS READS. An inline record's status is one SHORT reading about the setting — a state
 *  pill, a count, the model a role resolves to. It belongs to the label, not to the trailing side: it
 *  renders right after the help mark, on the label's own line. Given a track of its own it floated
 *  halfway between the record's name and its control, which is what made a card carrying one pill read
 *  as scattered. A STACKED record is the exception, because its status is a BLOCK — a provider's
 *  endpoint over a model count over a badge row — that cannot sit on the label's baseline; that one
 *  stays in the trailing band, and the band's status track exists for it.
 *
 *  Explanatory copy lives behind the shared HelpTip so the row remains scannable on a phone;
 *  `description` gives the short meaning and `hint` adds long-form or cautionary detail in the same
 *  click/hover surface. */
export function SettingsRow({ label, description, hint, icon: Icon, iconNode, control, status, actions, trailingLayout = 'inline', rowId, children, className = '' }: {
  label: string;
  description?: string;
  hint?: string;
  icon?: LucideIcon;
  /** A record whose badge is an image rather than a glyph — a provider's own favicon, say. Wins over
   *  `icon`, so a caller can hand in something that falls back to a glyph on its own. */
  iconNode?: ReactNode;
  /** THE control of the record: one switch, one select, one picker. Canonical spelling of what used to
   *  be passed as `children`, which remains an alias below. */
  control?: ReactNode;
  /** A SHORT reading of the record — a state word, a count, a timestamp. On an inline record it sits on
   *  the label's line, right after the help mark; anything long enough to need its own block belongs in
   *  `description`/`hint`, or in a record that declares `trailingLayout="stack"`. */
  status?: ReactNode;
  /** At most {@link MAX_ROW_ACTIONS} buttons. Development builds warn when a call site exceeds it
   *  rather than letting the row quietly overflow its line. */
  actions?: ReactNode;
  /** How much room the trailing side needs.
   *
   *  `inline` is the default record: ONE compact control opposite its label, with its short status read
   *  on the label's own line — the two-column table every settings card reads as.
   *
   *  `stack` is for a record whose trailing side is not one value but SEVERAL — a connected account
   *  carries a connection badge, a usage meter per rate-limit window and two buttons; a provider entry
   *  carries an endpoint, a model count, up to three badges and three buttons. Those cannot share a
   *  phone's ~120px value column: the meters collapse to zero width and the badges overrun the label,
   *  which is exactly what made the account and provider names unreadable. Declaring it here keeps the
   *  decision with the row that has the content, instead of leaving a stylesheet to guess from the DOM.
   *
   *  It changes nothing above the phone breakpoint — a wide card has the room for the inline form. */
  trailingLayout?: 'inline' | 'stack';
  /** The locale-independent anchor this record can be deep-linked to, emitted as `data-row-id`. The
   *  command palette links a row as `?cat=<section>&row=<rowId>` and the arriving page scrolls this
   *  element into view and blinks it once (`lib/useRowAnchor.ts`). Core call sites pass the row's
   *  dictionary path through `rowAnchor`, which checks it against the tables the palette links FROM; the
   *  prop itself is a plain string because plugin bundles render this component too. */
  rowId?: string;
  /** Alias of `control`, kept because `SettingsRow` is published to plugin bundles through
   *  `window.ElowenUiRuntime.components` and every existing bundle passes its control as children. The
   *  rendered DOM is identical either way. */
  children?: ReactNode;
  className?: string;
}) {
  const controlNode = control ?? children;
  // ONE decision about where the status reads, taken from the layout the row already declares — see the
  // contract above. An inline status joins the label line; a stacked one keeps the band's status track.
  const labelStatus = trailingLayout === 'inline' ? status : undefined;
  const bandStatus = trailingLayout === 'inline' ? undefined : status;
  if (process.env.NODE_ENV !== 'production' && countSlots(actions) > MAX_ROW_ACTIONS) {
    // eslint-disable-next-line no-console
    console.warn(`SettingsRow "${label}" carries more than ${MAX_ROW_ACTIONS} actions; move the extras into the section header.`);
  }
  return (
    <div className={`settings-row ${className}`} data-trailing={trailingLayout} data-row-id={rowId}>
      <div className="settings-row__label">
        {iconNode ? <span className="settings-row__icon" data-icon-kind="brand" aria-hidden>{iconNode}</span>
          : Icon ? <span className="settings-row__icon" data-icon-kind="glyph" aria-hidden><Icon size={15} strokeWidth={1.75} /></span> : null}
        <div className="min-w-0">
          <span className="settings-row__title">
            <span>{label}</span>
            {description || hint ? (
              <HelpTip align="left">
                {description ? <span className="block">{description}</span> : null}
                {hint ? <span className={`block ${description ? 'mt-2' : ''}`}>{hint}</span> : null}
              </HelpTip>
            ) : null}
            {labelStatus ? <span className="settings-row__status">{labelStatus}</span> : null}
          </span>
        </div>
      </div>
      {bandStatus || controlNode || actions ? (
        <div className="settings-row__trailing">
          {bandStatus ? <div className="settings-row__status">{bandStatus}</div> : null}
          {controlNode ? <div className="settings-row__control">{controlNode}</div> : null}
          {actions ? <div className="settings-row__actions">{actions}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function SettingsToolbar({ children, promote = true }: { children: ReactNode; promote?: boolean }) {
  const toolbar = <div className="control-surface-toolbar settings-toolbar">{children}</div>;
  return promote ? <WorkspaceLeadPortal>{toolbar}</WorkspaceLeadPortal> : toolbar;
}

export function SettingsState({ children, tone = 'default' }: { children: ReactNode; tone?: SettingsTone }) {
  return <div className="control-surface-state settings-state" data-tone={tone}>{children}</div>;
}
