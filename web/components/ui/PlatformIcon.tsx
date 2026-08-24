'use client';
import { Bot, Clock, MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Platforms we ship a brand mark for, under `web/public/platforms/`. Deliberately an ALLOW-LIST rather
 *  than "try the file and see": a platform name comes from a plugin, so guessing at an asset path would
 *  make every unknown platform cost a 404 on first paint. */
const BRAND_MARKS = new Set(['msteams', 'discord', 'whatsapp', 'telegram']);

/** Machine surfaces that are not places people talk. They get a plain glyph, since a delegated run and a
 *  scheduled job have no brand to show. */
const GLYPHS: Record<string, typeof Bot> = { subagent: Bot, cron: Clock };

/** How a platform id is spelled out for a screen reader and the hover title. */
const NAMES: Record<string, string> = {
  msteams: 'Microsoft Teams',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  subagent: 'Sub-agent',
  cron: 'Scheduled run',
};

export function platformName(platform: string): string {
  return NAMES[platform] ?? platform;
}

/** The mark for a conversation's platform: a brand icon where we have one, a glyph for machine surfaces,
 *  and a neutral message glyph for a platform we have never seen. Mirrors {@link ModelIcon}'s approach —
 *  an `<img>` off `public/`, falling back to a lucide glyph rather than a broken image. */
export function PlatformIcon({ platform, size = 14, className = '' }: { platform: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  // Reset per platform, so a row re-used for another conversation re-tries its asset.
  useEffect(() => { setFailed(false); }, [platform]);

  const title = platformName(platform);
  if (BRAND_MARKS.has(platform) && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/platforms/${platform}.svg`}
        alt=""
        title={title}
        className={`shrink-0 object-contain ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
        onError={() => setFailed(true)}
      />
    );
  }
  // The title rides on a wrapper: the lucide components do not take one, and dropping it would leave the
  // glyph with nothing naming the platform on hover.
  const Glyph = GLYPHS[platform] ?? MessageSquare;
  return (
    <span title={title} className="inline-flex shrink-0">
      <Glyph size={size} className={`text-text-muted ${className}`} aria-hidden />
    </span>
  );
}
