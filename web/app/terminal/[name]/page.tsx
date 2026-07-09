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
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
        <SquareTerminal size={14} className="text-text-muted" aria-hidden />
        <span className="truncate text-sm font-medium">{agentDisplayName(name)}</span>
      </div>
      <div className="min-h-0 flex-1">
        <StreamTerminal name={name} />
      </div>
    </div>
  );
}
