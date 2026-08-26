'use client';

import { useEffect, useMemo, useState, type ComponentType } from 'react';
import type { PluginUiRegistration, PluginUserPanelProps } from 'elowen-plugin-ui-kit';
import type { PluginUiListing, User } from '../../lib/types';
import { usePluginUi } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { loadPluginUi, PLUGIN_UI_API_VERSION } from '../../lib/pluginUi';
import { pluginLucideIcon } from '../../lib/pluginIcons';
import { DetailBlock } from '../../components/ui/DetailBlock';
import { ErrorState, LoadingState } from '../../components/ui/states';

type UserRegistration = PluginUiRegistration & {
  user?: Record<string, ComponentType<PluginUserPanelProps>>;
};
type UserPanel = { entry: PluginUiListing; id: string; label: string; icon?: string };

function PluginUserPanel({ panel, user }: { panel: UserPanel; user: User }) {
  const { t } = useTranslation();
  const [registration, setRegistration] = useState<UserRegistration | null | undefined>(undefined);
  const compatible = panel.entry.apiVersion <= PLUGIN_UI_API_VERSION;

  useEffect(() => {
    if (!compatible) return;
    let alive = true;
    void loadPluginUi(panel.entry.name, panel.entry.url, panel.entry.cssUrl).then((value) => {
      if (alive) setRegistration(value);
    });
    return () => { alive = false; };
  }, [compatible, panel.entry.cssUrl, panel.entry.name, panel.entry.url]);

  if (!compatible) return <ErrorState message={t.pluginUi.incompatible} />;
  if (registration === undefined) return <LoadingState variant="list" />;
  if (registration === null) return <ErrorState message={t.pluginUi.loadFailed} />;
  const Component = registration.user?.[panel.id];
  if (!Component) return <ErrorState message={t.pluginUi.settingsUnavailable} />;
  return <Component plugin={panel.entry.name} panelId={panel.id} user={user} surface="user" />;
}

export function PluginUserPanels({ user }: { user: User }) {
  const { locale } = useTranslation();
  const listing = usePluginUi(locale);
  const panels = useMemo<UserPanel[]>(() => (listing.data ?? []).flatMap((entry) =>
    (entry.user ?? []).map((panel) => ({ entry, ...panel }))), [listing.data]);

  return <>{panels.map((panel) => {
    const Icon = pluginLucideIcon(panel.icon);
    return <DetailBlock key={`${user.id}:${panel.entry.name}:${panel.id}`} icon={Icon} title={panel.label}><PluginUserPanel panel={panel} user={user} /></DetailBlock>;
  })}</>;
}
