'use client';

import { useEffect, useState, type ComponentType } from 'react';
import type { PluginPageProps, PluginUiRegistration } from 'elowen-plugin-ui-kit';

type AccountRegistration = PluginUiRegistration & { account?: Record<string, ComponentType<PluginPageProps>> };
import { ErrorState, LoadingState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { PLUGIN_UI_API_VERSION, loadPluginUi } from '../../lib/pluginUi';
import type { PluginUiListing } from '../../lib/types';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { pluginAccountSectionId } from './pluginSections';

export function PluginAccountSection({ entry, sectionId, onSaveState }: {
  entry: PluginUiListing;
  sectionId: string;
  onSaveState: (id: string, status: SaveStatus, retry?: () => void) => void;
}) {
  const { t } = useTranslation();
  const [registration, setRegistration] = useState<AccountRegistration | null | undefined>(undefined);
  const compatible = entry.apiVersion <= PLUGIN_UI_API_VERSION;

  useEffect(() => {
    if (!compatible) return;
    let alive = true;
    void loadPluginUi(entry.name, entry.url, entry.cssUrl).then((value) => { if (alive) setRegistration(value); });
    return () => { alive = false; };
  }, [compatible, entry.cssUrl, entry.name, entry.url]);

  if (!compatible) return <ErrorState message={t.pluginUi.incompatible} />;
  if (registration === undefined) return <LoadingState />;
  if (registration === null) return <ErrorState message={t.pluginUi.loadFailed} />;
  const Component = registration.account?.[sectionId] as ComponentType<PluginPageProps> | undefined;
  if (!Component) return <ErrorState message={t.pluginUi.settingsUnavailable} />;
  return (
    <Component
      plugin={entry.name}
      params={{ id: sectionId }}
      rest={[]}
      surface="deck"
      onSaveState={(status, retry) => onSaveState(pluginAccountSectionId(entry.name, sectionId), status, retry)}
    />
  );
}
