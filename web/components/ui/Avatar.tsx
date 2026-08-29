'use client';
import { useEffect, useState } from 'react';
import { elowenClient } from '../../lib/elowenClient';
import { Avatar as AvatarRoot, AvatarFallback, AvatarImage } from './shadcn/avatar';

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

/** A user's avatar: the uploaded image when present, else a coloured initials monogram.
 *
 *  Composed from the shadcn/ui `Avatar` parts in `./shadcn/avatar.tsx`. What is this file's is only the app's
 *  policy — which label to show, which two letters it becomes, which of eight identity colours backs it,
 *  and where the image URL comes from. The load/error handling under it is Radix's: `AvatarImage` paints
 *  only once the source has decoded and hands back to the fallback if it never does, so a broken avatar
 *  degrades to the monogram instead of a blank square, which the hand-rolled version did not do. */
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
  return (
    // The accessible name sits on the ROOT rather than on the image, because the root is the element
    // that is always present: Radix swaps image and fallback underneath it, and a name attached to the
    // image would disappear for exactly the users who have no image.
    // `inline-flex` rather than stock shadcn's block-level `flex`: an avatar here sits beside a name in
    // running text as often as it sits in a grid cell, and a block box there would break the line.
    <AvatarRoot aria-label={label} className="inline-flex" style={{ width: size, height: size }}>
      {user.avatar && src ? <AvatarImage src={src} alt={label} className="rounded-full border border-border" /> : null}
      <AvatarFallback
        className="font-mono font-semibold text-white"
        style={{ fontSize: size * 0.38, background: colorFor(label) }}
      >
        {initialsOf(label)}
      </AvatarFallback>
    </AvatarRoot>
  );
}
