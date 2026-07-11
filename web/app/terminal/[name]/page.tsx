'use client';
import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { SquareTerminal } from 'lucide-react';
import { agentDisplayName } from '../../../lib/agentUtils';
import { useTranslation } from '../../../lib/i18n';

// xterm references browser-only `self`; skip SSR so this chromeless window doesn't break prerender.
const StreamTerminal = dynamic(() => import('../../../components/terminal/StreamTerminal').then((m) => m.StreamTerminal), { ssr: false });

/** Chromeless pop-out window: a single full-viewport terminal for one session, no sidebar/dock. Still
 *  rendered inside the app's providers + auth gate (same-origin cookie), so it's authenticated like any
 *  other page — the Shell just skips its chrome for `/terminal/*` routes. */
export default function TerminalWindow() {
  const { t } = useTranslation();
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(String(params.name));
  // Chromeless pop-out: no ModuleHeader (and no pageHeader provider), so set the tab title directly.
  useEffect(() => { document.title = `${t.common.appName} — ${agentDisplayName(name)}`; }, [t.common.appName, name]);
  return (
    <div className="flex h-dvh flex-col bg-bg">
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
