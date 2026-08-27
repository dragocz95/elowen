'use client';
import { Children, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { HelpTip } from './HelpTip';

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
export function SettingsGroup({ title, description, icon: Icon, actions, tone = 'default', density = 'comfortable', columns = 1, children, className = '' }: {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  actions?: ReactNode;
  tone?: SettingsTone;
  density?: SettingsDensity;
  columns?: 1 | 2;
  /** Optional: a group whose whole story fits in its header (a title, a figure, one action) renders as a
   *  single row. An empty body div would still contribute its own padding and read as a stray gap. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section data-settings-group data-tone={tone} data-density={density} className={`settings-group ${className}`}>
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

/** A label/control record inside a section card: a ringed icon badge, the name with its explanation
 *  directly beneath it, and the control on the trailing edge.
 *
 *  TWO kinds of explanation, deliberately kept apart. `description` is the one-line plain-text gloss
 *  that belongs in the layout — a setting whose meaning hides behind a hover target is a setting people
 *  change by guessing. `hint` is the long-form or cautionary text (a plugin field's full help, a
 *  destructive-mode warning) and stays behind the shared HelpTip, which is what keeps plugin config
 *  calm and compact. Passing a paragraph as `description` would push every neighbouring row off the
 *  screen; passing a five-word gloss as `hint` would hide it for no reason. */
export function SettingsRow({ label, description, hint, icon: Icon, iconNode, status, actions, children, className = '' }: {
  label: string;
  description?: string;
  hint?: string;
  icon?: LucideIcon;
  /** A record whose badge is an image rather than a glyph — a provider's own favicon, say. Wins over
   *  `icon`, so a caller can hand in something that falls back to a glyph on its own. */
  iconNode?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`settings-row ${className}`}>
      <div className="settings-row__label">
        {iconNode ? <span className="settings-row__icon" aria-hidden>{iconNode}</span>
          : Icon ? <span className="settings-row__icon" aria-hidden><Icon size={15} strokeWidth={1.75} /></span> : null}
        <div className="min-w-0">
          <span className="settings-row__title">{label}{hint ? <HelpTip align="left">{hint}</HelpTip> : null}</span>
          {description ? <p className="settings-row__description">{description}</p> : null}
          {status ? <div className="settings-row__status">{status}</div> : null}
        </div>
      </div>
      {children ? <div className="settings-row__control">{children}</div> : null}
      {actions ? <div className="settings-row__actions">{actions}</div> : null}
    </div>
  );
}

export function SettingsToolbar({ children }: { children: ReactNode }) {
  return <div className="control-surface-toolbar settings-toolbar">{children}</div>;
}

export function SettingsState({ children, tone = 'default' }: { children: ReactNode; tone?: SettingsTone }) {
  return <div className="control-surface-state settings-state" data-tone={tone}>{children}</div>;
}
