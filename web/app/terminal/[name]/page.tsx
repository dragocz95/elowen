'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { SquareTerminal } from 'lucide-react';
import { agentDisplayName } from '../../../lib/agentUtils';
import { useTranslation } from '../../../lib/i18n';
import { useBrand } from '../../../lib/brand';
import { formatDocumentTitle } from '../../../lib/documentTitle';

// xterm references browser-only `self`; skip SSR so this chromeless window doesn't break prerender.
const StreamTerminal = dynamic(() => import('../../../components/terminal/StreamTerminal').then((m) => m.StreamTerminal), { ssr: false });

/** Chromeless pop-out window: a single full-viewport terminal for one session, no sidebar/dock. Still
 *  rendered inside the app's providers + auth gate (same-origin cookie), so it's authenticated like any
 *  other page — the Shell just skips its chrome for `/terminal/*` routes. */
export default function TerminalWindow() {
  const { t } = useTranslation();
  const { appName } = useBrand();
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(String(params.name));
  return (
    <div className="flex h-dvh flex-col bg-bg">
      {/* The global DocumentTitle deliberately skips /terminal/*, so this chromeless pop-out names its
          own tab. The session is not a navigation destination, so its name is the agent's, composed
          through the shared separator. */}
      <title>{formatDocumentTitle(appName, agentDisplayName(name))}</title>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/80 bg-surface px-4">
        <span className="grid h-8 w-8 place-items-center rounded-full border border-accent/25 bg-accent/[0.035] text-accent"><SquareTerminal size={14} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[8px] font-semibold uppercase tracking-[.18em] text-accent/70">Terminal</div>
          <span className="block truncate text-sm font-medium text-text">{agentDisplayName(name)}</span>
        </div>
        <span className="workspace-status">{t.sessions.online}</span>
      </div>
      <div className="min-h-0 flex-1">
        <StreamTerminal name={name} />
      </div>
    </div>
  );
}
