'use client';
import { useEffect, useState } from 'react';
import { elowenClient } from '../../lib/elowenClient';
import { Avatar as AvatarRoot, AvatarFallback, AvatarImage } from './shadcn/avatar';

/** How many identity chips exist. Eight leaves neighbouring hues 45° apart — far enough to tell two
 *  people apart at 36px — while keeping a collision in one team unlikely. */
const IDENTITY_STEPS = 8;
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
/** A label's identity chip, as a hue rotation off the brand primary. Deterministic — the same person
 *  always gets the same chip — and summed by CODE POINT, like {@link initialsOf}, so a non-ASCII name
 *  buckets like any other.
 *
 *  The eight colours used to be eight hex literals, which froze the identity ramp at the built-in
 *  design's ember: it survived every skin and every repaint, and it carried `text-white` ink that was
 *  ~2:1 on its own amber step. Rotating `bg-primary` instead keeps the ramp on the token layer, so a
 *  skin repaints all eight at once — and because `hue-rotate`'s matrix is luminance-preserving (each
 *  row sums to exactly 1, which also leaves achromatic ink untouched), every chip reads against
 *  `text-primary-foreground` exactly as `bg-primary` itself does. The contrast pairing is therefore
 *  correct by construction rather than per-colour luck.
 *
 *  The trade the old palette was making is real and is accepted here: a design whose primary is nearly
 *  grey gets eight nearly-grey chips. The monogram letters stay the primary identifier in that case,
 *  and a brand with no chroma has nothing to spread eight ways however the colours are chosen. */
export const identityHueOf = (s: string) =>
  ([...s].reduce((sum, c) => sum + c.codePointAt(0)!, 0) % IDENTITY_STEPS) * (360 / IDENTITY_STEPS);

/** A user's avatar: the uploaded image when present, else a coloured initials monogram.
 *
 *  Composed from the shadcn/ui `Avatar` parts in `./shadcn/avatar.tsx`. What is this file's is only the app's
 *  policy — which label to show, which two letters it becomes, which of eight identity hues backs it,
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
        className="bg-primary font-mono font-semibold text-primary-foreground"
        style={{ fontSize: size * 0.38, filter: `hue-rotate(${identityHueOf(label)}deg)` }}
      >
        {initialsOf(label)}
      </AvatarFallback>
    </AvatarRoot>
  );
}
