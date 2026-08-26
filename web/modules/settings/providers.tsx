'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

export interface ProviderMeta { id: string; label: string; color: string; binHint: string; argsHint: string; icon: string; /** Provider has no skip-permissions command-line flag (its tools either run without confirmation or auto-approval is set in the tool's own config), so the toggle is a no-op and hidden. */ noBypassFlag?: boolean; /** Runs inside the Elowen daemon (embedded brain) — no binary/args to configure. */ embedded?: boolean }

const ICON_PATHS = ['favicon.ico', 'favicon.png', 'favicon.svg'] as const;

/** Where a configured endpoint's brand icon might live, most likely first.
 *
 *  The icon belongs to the BRAND domain, not to the API host: `z.ai` serves one and `api.z.ai` answers
 *  404, which is the whole reason this exists. So the host is tried with a leading `api.`/`www.` label
 *  removed, then — for a deeper host like `ai.coresynth.io`, whose own root has none — with just its
 *  registrable root, and each host at the three conventional filenames.
 *
 *  Every candidate is a plain image request straight to the provider. No third-party favicon service
 *  sits in the middle, so opening Settings tells nobody except the provider you already talk to. */
export function faviconCandidates(baseUrl: string | undefined): string[] {
  if (!baseUrl) return [];
  let host: string;
  try { host = new URL(baseUrl).hostname; } catch { return []; }
  // An address or a private name has no brand icon to fetch, and asking would be a pointless request.
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.endsWith('.local')) return [];
  const labels = host.split('.');
  const hosts = new Set<string>();
  hosts.add(labels[0] === 'api' || labels[0] === 'www' ? labels.slice(1).join('.') : host);
  if (labels.length > 2) hosts.add(labels.slice(-2).join('.'));
  return [...hosts].flatMap((one) => ICON_PATHS.map((file) => `https://${one}/${file}`));
}

/** The provider's own favicon, walking the candidates on each load error and handing over to `fallback`
 *  once they run out — so a provider that publishes no icon keeps the generic glyph rather than a hole. */
export function DomainFavicon({ baseUrl, fallback, size = 15 }: { baseUrl?: string; fallback?: ReactNode; size?: number }) {
  const candidates = useMemo(() => faviconCandidates(baseUrl), [baseUrl]);
  const [index, setIndex] = useState(0);
  useEffect(() => { setIndex(0); }, [baseUrl]);
  const src = candidates[index];
  if (!src) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={src}
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      style={{ width: size, height: size, objectFit: 'contain' }}
      onError={() => setIndex((current) => current + 1)}
    />
  );
}

export const PROVIDERS: ProviderMeta[] = [
  { id: 'claude-code', label: 'Claude Code', color: '#d97757', binHint: 'claude', argsHint: '--permission-mode acceptEdits', icon: '/providers/anthropic.png' },
  { id: 'opencode', label: 'OpenCode', color: '#7c8cff', binHint: 'opencode', argsHint: '--pure', icon: '/providers/opencode.png' },
  { id: 'codex', label: 'Codex', color: '#ededed', binHint: 'codex', argsHint: '--full-auto', icon: '/providers/openai.svg' },
  { id: 'kilo', label: 'Kilo Code', color: '#c2e812', binHint: 'kilo', argsHint: '', icon: '/providers/kilo.svg', noBypassFlag: true },
  { id: 'elowen', label: 'Elowen AI', color: '#3b82f6', binHint: '', argsHint: '', icon: '/icon.png', embedded: true },
];

export function ProviderLogo({ meta, alt, size = 36 }: { meta: ProviderMeta; alt?: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-elevated"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={meta.icon} alt={alt ?? meta.label} width={size * 0.62} height={size * 0.62} style={{ objectFit: 'contain' }} />
    </span>
  );
}

export const providerMeta = (id: string): ProviderMeta | undefined => PROVIDERS.find((p) => p.id === id);
