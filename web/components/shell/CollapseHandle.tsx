'use client';

/** The one collapse control for the primary navigation: a full-height strip on the navigation's
 *  content-facing edge, carrying a thin, dark pill that lights up and grows on hover. Long and quiet, so
 *  it reads as an affordance on the seam rather than a button competing with the destinations.
 *
 *  It lives on the edge FACING THE CONTENT, which flips when the dock takes the left edge and the
 *  navigation mirrors to the right — that rule belongs here, not in each caller. It renders inside the
 *  navigation's own box because those boxes clip their overflow; a strip hung outside would be cut off. */
export function CollapseHandle({ side, label, onToggle }: {
  /** Which edge of the shell the navigation itself sits on. */
  side: 'left' | 'right';
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      data-testid="nav-collapse-handle"
      className={`group absolute inset-y-0 z-30 flex w-[13px] cursor-pointer items-center justify-center ${side === 'right' ? 'left-0' : 'right-0'}`}
    >
      <span className="h-8 w-[3px] rounded-full bg-border transition-all duration-200 group-hover:h-12 group-hover:bg-muted-foreground" aria-hidden />
    </button>
  );
}
