'use client';
import { useEffect, useState } from 'react';
import { elowenClient } from '../../lib/elowenClient';

// Deterministic monogram colour so a given user always gets the same chip.
const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
/** Two letters, chosen by what the label actually is. A full name gives one initial per word, so
 *  "Filip Džudža" reads as FD — plain `slice(0, 2)` said FI, which is why the team rail kept its own
 *  copy of this. A single word (a bare username) has no second word to draw from, so it keeps its first
 *  two letters: "alex" as AL is more distinguishable than a lone A. Everything is taken by CODE POINT;
 *  slicing UTF-16 units halves an astral first letter. */
const initialsOf = (s: string) => {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1
    ? [...words[0]!].slice(0, 2)
    : words.slice(0, 2).map((w) => [...w][0] ?? '');
  return letters.join('').toUpperCase() || '?';
};
const colorFor = (s: string) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

/** A user's avatar: the uploaded image when present, else a coloured initials monogram. */
export function Avatar({ user, size = 36 }: { user: { id: number; username: string; name?: string; avatar?: string }; size?: number }) {
  const label = user.name?.trim() || user.username;
  // The avatar URL is a short-lived signed link minted on demand (finding W2) — fetch it when the
  // user has an uploaded avatar; fall back to the monogram until (and if) it resolves.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!user.avatar) { setSrc(null); return; }
    let live = true;
    elowenClient.avatarUrl(user.id).then((u) => { if (live) setSrc(u); }).catch(() => { if (live) setSrc(null); });
    return () => { live = false; };
  }, [user.id, user.avatar]);
  if (user.avatar && src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={label}
        className="shrink-0 rounded-full border border-border object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-mono font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.38, background: colorFor(label) }}
      aria-label={label}
    >
      {initialsOf(label)}
    </span>
  );
}
