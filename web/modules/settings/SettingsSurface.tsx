import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { HelpTip } from '../../components/ui/HelpTip';

type SettingsTone = 'default' | 'danger';
type SettingsDensity = 'comfortable' | 'compact';

export function SettingsDocument({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div data-control-surface data-settings-document className={`control-surface-document settings-document ${className}`}>{children}</div>;
}

export function SettingsGroup({ title, description, icon: Icon, actions, tone = 'default', density = 'comfortable', children, className = '' }: {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  actions?: ReactNode;
  tone?: SettingsTone;
  density?: SettingsDensity;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section data-settings-group data-tone={tone} data-density={density} className={`settings-group ${className}`}>
      {title || description || actions ? (
        <header className="settings-group__header">
          <div className="settings-group__heading">
            {Icon ? <span className="settings-group__icon" aria-hidden><Icon size={17} strokeWidth={1.5} /></span> : null}
            <div>
              {title ? <h2>{title}</h2> : null}
              {description ? <p>{description}</p> : null}
            </div>
          </div>
          {actions ? <div className="settings-group__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="settings-group__body">{children}</div>
    </section>
  );
}

export function SettingsRow({ label, description, icon: Icon, status, actions, children, className = '' }: {
  label: string;
  description?: string;
  icon?: LucideIcon;
  status?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`settings-row ${className}`}>
      <div className="settings-row__label">
        {Icon ? <span className="settings-row__icon" aria-hidden><Icon size={16} strokeWidth={1.5} /></span> : null}
        <div className="min-w-0">
          <span className="settings-row__title">{label}{description ? <HelpTip align="left">{description}</HelpTip> : null}</span>
          {status ? <div className="settings-row__status">{status}</div> : null}
        </div>
      </div>
      {children ? <div className="settings-row__control">{children}</div> : null}
      {actions ? <div className="settings-row__actions">{actions}</div> : null}
    </div>
  );
}

export function SettingsToolbar({ children }: { children: ReactNode }) {
  return <div className="control-surface-toolbar settings-toolbar">{children}</div>;
}

export function SettingsState({ children, tone = 'default' }: { children: ReactNode; tone?: SettingsTone }) {
  return <div className="control-surface-state settings-state" data-tone={tone}>{children}</div>;
}
