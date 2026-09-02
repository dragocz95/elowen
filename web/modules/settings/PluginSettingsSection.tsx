'use client';

import { useEffect, useState, type ComponentType } from 'react';
import type { PluginPageProps, PluginUiRegistration } from 'elowen-plugin-ui-kit';
import { ErrorState, LoadingState } from '../../components/ui/states';
import { PluginErrorBoundary } from '../../components/plugin/PluginUiGuards';
import { useTranslation } from '../../lib/i18n';
import { PLUGIN_UI_API_VERSION, loadPluginUi } from '../../lib/pluginUi';
import type { PluginUiListing } from '../../lib/types';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';

/** One `web.settings` section of a plugin, mounted inside that plugin's detail workspace.
 *
 *  The same component the plugin serves at `/p/<plugin>/settings/<id>`, rendered with `surface="deck"`
 *  because the workspace tab around it already names the section and supplies the panel it sits on — a
 *  section on a page draws its own header instead, and doing both would title it twice.
 *
 *  Loading, an incompatible bundle and a failed load are three different answers and each is said plainly:
 *  the reader opened this tab on purpose, so silence would leave them waiting on a surface that will never
 *  fill. The boundary is here rather than around the whole workspace so a bundle that throws costs its own
 *  tab and not the configuration form beside it. */
export function PluginSettingsSection({ entry, sectionId, onSaveState }: {
  entry: PluginUiListing;
  sectionId: string;
  onSaveState: (status: SaveStatus, retry?: () => void) => void;
}) {
  const { t } = useTranslation();
  const [registration, setRegistration] = useState<PluginUiRegistration | null | undefined>(undefined);
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
  const Component = registration.settings?.[sectionId] as ComponentType<PluginPageProps> | undefined;
  // The listing offered this section by name, so "the bundle registered nothing for it" is its own
  // answer — not the page-missing notice, which would reply to a question nobody asked.
  if (!Component) return <ErrorState message={t.pluginUi.settingsUnavailable} />;
  return (
    <PluginErrorBoundary notice={t.pluginUi.crashed}>
      <Component
        plugin={entry.name}
        params={{ id: sectionId }}
        rest={[]}
        surface="deck"
        onSaveState={onSaveState}
      />
    </PluginErrorBoundary>
  );
}
