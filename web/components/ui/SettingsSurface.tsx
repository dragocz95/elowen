'use client';
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { HelpTip } from './HelpTip';
import { WorkspaceLeadPortal } from './WorkspaceShell';

type SettingsTone = 'default' | 'danger';
type SettingsDensity = 'comfortable' | 'compact';

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
 *  reflow the same rows into one box and take that alignment away. */
export function SettingsGroup({ title, description, icon: Icon, actions, tone = 'default', density = 'comfortable', columns = 1, rowId, children, className = '' }: {
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
  /** Optional: a group whose whole story fits in its header (a title, a figure, one action) renders as a
   *  single row. An empty body div would still contribute its own padding and read as a stray gap. */
  children?: ReactNode;
  className?: string;
}) {
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
 *  stack through subgrid; in a narrow container it folds to a two-line band — the label and its help on
 *  the first line, the control, status and actions together on a second line that does not wrap. There
 *  is deliberately no third line: a record that needs one is carrying several values and should declare
 *  `trailingLayout="stack"`, which opts out of the band and gives each part the row's full width.
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
  /** A SHORT trailing value — a state word, a count, a timestamp. It shares one line with the control
   *  and the actions, so anything that needs to wrap belongs in `description`/`hint` instead. */
  status?: ReactNode;
  /** At most {@link MAX_ROW_ACTIONS} buttons. Development builds warn when a call site exceeds it
   *  rather than letting the row quietly overflow its line. */
  actions?: ReactNode;
  /** How much room the trailing side needs.
   *
   *  `inline` is the default record: ONE compact value (a switch, a select, a short status) that sits
   *  opposite its label, and the two-column table every settings card reads as.
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
          </span>
        </div>
      </div>
      {status || controlNode || actions ? (
        <div className="settings-row__trailing">
          {status ? <div className="settings-row__status">{status}</div> : null}
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
