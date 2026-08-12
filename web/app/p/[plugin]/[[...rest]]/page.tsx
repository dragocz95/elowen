'use client';
export const dynamic = 'force-dynamic';
import { useEffect, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ModuleShell } from '../../../../components/shell/ModuleShell';
import { SettingsDocument } from '../../../../modules/settings/SettingsSurface';
import { CompactWorkspaceHeader, WorkspacePage } from '../../../../components/ui/WorkspacePrimitives';
import { ModuleHeader } from '../../../../components/ui/ModuleHeader';
import { MotionReveal } from '../../../../components/ui/Motion';
import { pluginLucideIcon } from '../../../../lib/pluginIcons';
import { PluginErrorBoundary, PluginPlaceholder as Placeholder } from '../../../../components/plugin/PluginUiGuards';
import { usePluginUi } from '../../../../lib/queries';
import { useTranslation } from '../../../../lib/i18n';
import {
  PLUGIN_UI_API_VERSION, loadPluginUi, matchPluginPage, setPluginNavigate,
  type PluginUiRegistration,
} from '../../../../lib/pluginUi';

/** Host route for plugin browser UIs: /p/<plugin>/<...rest>. Resolves the plugin from the authed
 *  listing, loads its bundle once, and renders the matched page (or settings component under
 *  `settings/<id>`) inside an error boundary. */
export default function PluginHostPage() {
  const params = useParams<{ plugin: string; rest?: string[] }>();
  const plugin = params.plugin;
  const rest = params.rest ?? [];
  const router = useRouter();
  const { t, locale } = useTranslation();
  const listing = usePluginUi(locale);
  const [registration, setRegistration] = useState<PluginUiRegistration | null | undefined>(undefined);

  // Plugin bundles navigate through the host's SPA router while this route is mounted.
  useEffect(() => { setPluginNavigate((href) => router.push(href)); }, [router]);

  const entry = listing.data?.find((p) => p.name === plugin);
  const compatible = entry !== undefined && entry.apiVersion <= PLUGIN_UI_API_VERSION;

  useEffect(() => {
    if (!entry || !compatible) return;
    let alive = true;
    void loadPluginUi(entry.name, entry.url).then((reg) => { if (alive) setRegistration(reg); });
    return () => { alive = false; };
  }, [entry, compatible]);

  const strings = t.pluginUi;
  let body: ReactNode;
  if (listing.isLoading) body = null;
  else if (!entry) body = <Placeholder text={strings.unavailable} />;
  else if (!compatible) body = <Placeholder text={strings.incompatible} />;
  else if (registration === undefined) body = null; // bundle loading
  else if (registration === null) body = <Placeholder text={strings.loadFailed} />;
  else {
    const page = matchPluginPage(registration.pages, rest);
    // `/p/<plugin>` also resolves to the only settings section of a plugin that has nothing else, so its
    // address does not have to repeat its own name (`/p/skills/settings/skills`). Pages still win the bare
    // route, and `settings/<id>` keeps working for every plugin and every existing link.
    const sole = !page && rest.length === 0 && entry.nav.length === 0 && entry.settings.length === 1
      ? entry.settings[0] : undefined;
    const section = rest[0] === 'settings' && rest.length === 2
      ? entry.settings.find((s) => s.id === rest[1])
      : sole;
    const settingsComponent = section ? registration.settings?.[section.id] : undefined;
    const match = settingsComponent && section
      ? { Component: settingsComponent, params: { id: section.id } }
      : page;
    const rendered = match
      ? <match.Component plugin={plugin} params={match.params} rest={rest} />
      : <Placeholder text={strings.pageMissing} />;
    // A settings section is written for the Settings deck: the deck's panel supplies the document surface
    // its groups sit on, and the deck page supplies the masthead title and the page column. Reached
    // directly it has to bring all three, or it reads as a fragment pasted onto an empty screen.
    body = settingsComponent && section ? (
      <WorkspacePage>
        <ModuleHeader title={section.label} icon={pluginLucideIcon(section.icon)} />
        <CompactWorkspaceHeader eyebrow={strings.eyebrow} title={section.label} icon={pluginLucideIcon(section.icon)} />
        <MotionReveal>
          <SettingsDocument>{rendered}</SettingsDocument>
        </MotionReveal>
      </WorkspacePage>
    ) : rendered;
  }

  return (
    <ModuleShell moduleId={`plugin-${plugin}`}>
      <PluginErrorBoundary notice={strings.crashed}>{body}</PluginErrorBoundary>
    </ModuleShell>
  );
}
