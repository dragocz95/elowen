'use client';
import { useTranslation } from '../../lib/i18n';
import { useBrand } from '../../lib/brand';

/**
 * Opens the existing Brain dock. The launcher deliberately uses Elowen's flat product icon rather
 * than a generated/3D mascot; the small breathing halo supplies presence without changing her look.
 */
export function AdvisorLauncher({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const { iconSrc } = useBrand();

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t.advisor.open}
      title={t.advisor.title}
      className="group fixed bottom-4 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/25 bg-surface/90 shadow-[0_14px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-1 hover:border-accent/50 hover:shadow-[0_18px_48px_color-mix(in_srgb,var(--color-accent)_18%,transparent)] active:translate-y-0 active:scale-95"
    >
      <span className="ambient-pulse absolute inset-1 animate-pulse rounded-[0.8rem] bg-accent/10 opacity-60" aria-hidden />
      <img src={iconSrc} alt="" className="relative h-9 w-9 rounded-xl transition-transform duration-300 group-hover:scale-105" aria-hidden />
    </button>
  );
}
