'use client';
import type { ReactNode } from 'react';

/** One identity this account owns somewhere else, as a row of the Linked accounts drawer.
 *
 *  Every row is the same shape whatever supplies it: the platform's mark, its name, the actions that
 *  change the link, and below them the value that IS the link — an id the account pastes for a chat
 *  platform, the login an OAuth connector already resolved. A plugin reaches this through the UI
 *  runtime rather than rebuilding it, which is the whole point: the drawer previously mixed 18px rows
 *  against a 72px avatar with its own card, because nothing shared forced them to agree.
 *
 *  The row deliberately holds no opinion about what "connected" means or which actions exist. That
 *  belongs to whoever owns the identity — the host for the chat platforms below, the plugin for its
 *  own connector. */
export function LinkedAccountRow({ icon, title, actions, children, description }: {
  /** The platform's own mark, drawn at 18px by the caller so one identity is one logo across the app. */
  icon: ReactNode;
  title: string;
  /** Whatever changes the link. Quiet by convention — `ghost` buttons, danger only for disconnect —
   *  because no one opens this drawer looking for them. */
  actions?: ReactNode;
  /** The link itself: an editable id, or a resolved account rendered as plain monospace text. */
  children?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="py-3.5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{title}</span>
        {actions ? <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">{actions}</span> : null}
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
      {description ? <p className="mt-2 text-xs leading-relaxed text-text-muted">{description}</p> : null}
    </div>
  );
}
