/**
 * The original flat Elowen mascot as a quiet page accent. The surrounding aura and slow drift add
 * presence without redrawing the character, adding a card, or competing with the page controls.
 */
export function PageMascot({ className = '' }: { className?: string }) {
  return (
    <span
      data-testid="page-mascot"
      aria-hidden
      className={`relative hidden h-14 w-14 shrink-0 place-items-center sm:grid ${className}`}
    >
      <span className="status-orb absolute inset-[22%] rounded-full text-accent" />
      {/* eslint-disable-next-line @next/next/no-img-element -- local brand asset, intentionally unchanged */}
      <img src="/icon.png" alt="" draggable={false} className="animate-ambient relative h-12 w-12 select-none object-contain drop-shadow-[0_8px_18px_rgb(255_82_54_/_0.18)]" />
    </span>
  );
}
