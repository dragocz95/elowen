import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function SettingCard({ title, description, icon: Icon, children }: { title: string; description?: string; icon?: LucideIcon; children: ReactNode }) {
  return (
    <div className="card-interactive flex flex-col gap-3.5 rounded-lg border border-border bg-surface p-5">
      <div className="flex items-start gap-3">
        {Icon ? <Icon size={16} className="mt-0.5 text-text-muted" aria-hidden /> : null}
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text">{title}</span>
          {description ? <span className="font-mono text-xs text-text-muted">{description}</span> : null}
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
