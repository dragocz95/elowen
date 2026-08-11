'use client';
/** One plugin-contributed Settings section: resolves the plugin in the live /plugins/ui listing,
 *  loads its bundle once (the same cached load as the /p/<plugin> host route) and renders the
 *  settings component the bundle registered under this id — inside an error boundary, because a
 *  plugin panel must never take down the Settings page. A plugin whose manifest declares the section
 *  but whose bundle registers no component for it gets an honest placeholder instead. */
import { useEffect, useState } from 'react';
import { useTranslation } from '../../lib/i18n';
import { usePluginUi } from '../../lib/queries';
import { PLUGIN_UI_API_VERSION, loadPluginUi, type PluginUiRegistration } from '../../lib/pluginUi';
import { PluginErrorBoundary, PluginPlaceholder } from '../../components/plugin/PluginUiGuards';

export function PluginSettingsPanel({ plugin, settingId }: { plugin: string; settingId: string }) {
  const { t, locale } = useTranslation();
  const listing = usePluginUi(locale);
  const [registration, setRegistration] = useState<PluginUiRegistration | null | undefined>(undefined);

  const entry = listing.data?.find((p) => p.name === plugin);
  const compatible = entry !== undefined && entry.apiVersion <= PLUGIN_UI_API_VERSION;

  useEffect(() => {
    if (!entry || !compatible) return;
    let alive = true;
    void loadPluginUi(entry.name, entry.url).then((reg) => { if (alive) setRegistration(reg); });
    return () => { alive = false; };
  }, [entry, compatible]);

  const strings = t.pluginUi;
  if (listing.isLoading) return null;
  if (!entry) return <PluginPlaceholder text={strings.unavailable} />;
  if (!compatible) return <PluginPlaceholder text={strings.incompatible} />;
  if (registration === undefined) return null; // bundle loading
  if (registration === null) return <PluginPlaceholder text={strings.loadFailed} />;
  const Component = registration.settings?.[settingId];
  if (!Component) return <PluginPlaceholder text={strings.settingsUnavailable} />;
  return (
    <PluginErrorBoundary notice={strings.crashed}>
      <Component plugin={plugin} params={{ id: settingId }} rest={['settings', settingId]} />
    </PluginErrorBoundary>
  );
}
