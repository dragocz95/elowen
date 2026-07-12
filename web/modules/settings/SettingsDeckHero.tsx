'use client';

import { ArrowRight, Globe2, RefreshCw, Server } from 'lucide-react';
import type { SpatialDeckSection } from '../../components/ui/SpatialControlDeck';
import type { SystemInfo } from '../../lib/types';
import { SectionHeroSummary } from '../../components/ui/SectionHeroSummary';

interface HeroLabels {
  appName: string;
  upToDate: string;
  updateAvailable: string;
  lastUpdated: string;
  checkUpdates: string;
  daemon: string;
  web: string;
  running: string;
  restartDaemon: string;
  restartWeb: string;
}

export function SettingsDeckHero({ section, system, labels, onCheckUpdates, onRestart }: {
  section: SpatialDeckSection;
  system?: SystemInfo;
  labels: HeroLabels;
  onCheckUpdates: () => void;
  onRestart: (target: 'daemon' | 'web') => void;
}) {
  if (section.id !== 'system') {
    return <SectionHeroSummary icon={section.icon} title={section.label} description={section.description} />;
  }

  const updateLabel = system?.updateAvailable
    ? labels.updateAvailable.replace('{v}', system.latest ?? '')
    : labels.upToDate;

  return (
    <div className="settings-system-hero">
      <div className="settings-system-hero__identity">
        <div className="settings-system-hero__title">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="" aria-hidden />
          <strong>{labels.appName}</strong>
          <span>{system?.version ?? '—'}</span>
        </div>
        <span className={`settings-system-hero__badge ${system?.updateAvailable ? 'settings-system-hero__badge--warning' : ''}`}>{updateLabel}</span>
        {system?.lastUpdatedAt ? <small>{labels.lastUpdated.replace('{date}', new Date(system.lastUpdatedAt).toLocaleString())}</small> : null}
        <button type="button" className="spatial-inline-action" onClick={onCheckUpdates}>{labels.checkUpdates}<ArrowRight size={14} aria-hidden /></button>
      </div>

      <div className="settings-system-topology" aria-label={labels.running}>
        <span className="settings-system-topology__trunk" aria-hidden />
        {([
          { id: 'daemon' as const, label: labels.daemon, port: ':4400', icon: Server, action: labels.restartDaemon },
          { id: 'web' as const, label: labels.web, port: ':4500', icon: Globe2, action: labels.restartWeb },
        ]).map((service) => {
          const Icon = service.icon;
          return (
            <div key={service.id} className="settings-system-topology__service">
              <span className="settings-system-topology__node"><Icon size={21} strokeWidth={1.45} aria-hidden /></span>
              <strong>{service.label} <span>{service.port}</span></strong>
              <span className="settings-system-topology__status"><i aria-hidden />{labels.running}</span>
              <button type="button" className="spatial-inline-action" onClick={() => onRestart(service.id)}>{service.action}<RefreshCw size={12} aria-hidden /></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
