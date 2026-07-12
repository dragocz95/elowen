import type { LucideIcon } from 'lucide-react';

/** Canonical identity block for ordinary Account/Settings control-deck sections. */
export function SectionHeroSummary({ icon: Icon, title, description }: {
  icon: LucideIcon;
  title: string;
  description?: string;
}) {
  return (
    <div className="section-hero-summary">
      <span className="section-hero-summary__icon"><Icon size={28} strokeWidth={1.45} aria-hidden /></span>
      <div>
        <span className="section-hero-summary__label">{title}</span>
        {description ? <p>{description}</p> : null}
      </div>
    </div>
  );
}
