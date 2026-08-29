'use client';
export const dynamic = 'force-dynamic';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Blocks, Settings2 } from 'lucide-react';
import { ModuleShell } from '../../../../components/shell/ModuleShell';
import { WorkspacePage } from '../../../../components/ui/WorkspacePrimitives';
import { WorkspaceShell } from '../../../../components/ui/WorkspaceShell';
import { ControlSurfaceDocument, ControlSurfaceState } from '../../../../components/ui/ControlSurface';
import { ModuleHeader } from '../../../../components/ui/ModuleHeader';
import { AutoSaveStatus } from '../../../../components/ui/AutoSaveStatus';
import type { SaveStatus } from '../../../../lib/useAutoSaveStatus';
import { MotionReveal } from '../../../../components/ui/Motion';
import { Button } from '../../../../components/ui/Button';
import { EmptyState } from '../../../../components/ui/states';
import { pluginLucideIcon } from '../../../../lib/pluginIcons';
import { PluginErrorBoundary, PluginPlaceholder as Placeholder } from '../../../../components/plugin/PluginUiGuards';
import { usePluginUi, useMe } from '../../../../lib/queries';
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
  // Why the plugin is missing from the listing depends on who is asking. For an admin it is off (or has
  // no UI) and they can fix that; for anybody else the plugin may well be running — they just hold no
  // grant for it, and the settings page they would be sent to is admin-only.
  const isAdmin = useMe().data?.user?.is_admin === true;
  const [registration, setRegistration] = useState<PluginUiRegistration | null | undefined>(undefined);
  // A settings section autosaves and reports the outcome to whoever hosts it. In the Settings deck that
  // was the deck header; a section reached as a page has no other place to say that a save failed — and
  // an orbital section has no header of its own to fall back on.
  const [save, setSave] = useState<{ status: SaveStatus; retry?: () => void }>({ status: 'idle' });
  const reportSaveState = useCallback((status: SaveStatus, retry?: () => void) => { setSave({ status, retry }); }, []);

  // Plugin bundles navigate through the host's SPA router while this route is mounted.
  useEffect(() => { setPluginNavigate((href) => router.push(href)); }, [router]);

  const entry = listing.data?.find((p) => p.name === plugin);
  const compatible = entry !== undefined && entry.apiVersion <= PLUGIN_UI_API_VERSION;

  useEffect(() => {
    if (!entry || !compatible) return;
    let alive = true;
    void loadPluginUi(entry.name, entry.url, entry.cssUrl).then((reg) => { if (alive) setRegistration(reg); });
    return () => { alive = false; };
  }, [entry, compatible]);

  const strings = t.pluginUi;
  // A plugin that is off is a page the operator can still land on — from a bookmark, from the address
  // bar, or from a link that predates the switch. It gets the chrome of a page (masthead, tab title)
  // and the one action that resolves it, instead of a bare sentence on an empty screen.
  const notice = (text: string, withAction = false) => (
    <>
      {/* Draws nothing: it publishes the page name for the shell masthead and the browser tab, exactly
          as every other workspace page does alongside its shell. */}
      <ModuleHeader title={entry?.label ?? plugin} icon={Blocks} />
      <WorkspaceShell
        variant="single"
        hero={{ eyebrow: strings.eyebrow, title: entry?.label ?? plugin, icon: Blocks, mascot: 'error' }}
      >
        <ControlSurfaceDocument>
          <ControlSurfaceState>
            <EmptyState
              title={strings.unavailableTitle}
              description={text}
              icon={Blocks}
              action={withAction
                ? <Button variant="accent" icon={Settings2} onClick={() => router.push('/settings?cat=plugins')}>{strings.manage}</Button>
                : undefined}
            />
          </ControlSurfaceState>
        </ControlSurfaceDocument>
      </WorkspaceShell>
    </>
  );

  let body: ReactNode;
  if (listing.isLoading) body = null;
  else if (!entry) body = notice(isAdmin ? strings.unavailable : strings.notGranted, isAdmin);
  else if (!compatible) body = notice(strings.incompatible);
  else if (registration === undefined) body = null; // bundle loading
  else if (registration === null) body = notice(strings.loadFailed, true);
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
    // A declared section whose bundle registered no component is a different miss from an unknown page:
    // the menu offered settings by name, so saying "page missing" would answer a question nobody asked.
    const rendered = match
      ? <match.Component plugin={plugin} params={match.params} rest={rest} surface="page" {...(settingsComponent && section ? { onSaveState: reportSaveState } : {})} />
      : <Placeholder text={section ? strings.settingsUnavailable : strings.pageMissing} />;
    // A section that draws its own page shell has already been given the page column by that shell, so
    // wrapping it again nests two page frames: the gutter and the bottom padding apply twice and the
    // page comes out narrower than every sibling register. Only the bundle knows what its component
    // renders, which is why it declares the ids it frames itself.
    const ownsFrame = section !== undefined && registration.ownsPageFrame?.includes(section.id) === true;
    // A settings section is written for the Settings deck: the deck's panel supplies the document surface
    // its groups sit on, and the deck page supplies the masthead title and the page column. Reached
    // directly it has to bring all three, or it reads as a fragment pasted onto an empty screen.
    body = settingsComponent && section && !ownsFrame ? (
      <WorkspacePage>
        {/* The masthead and the browser tab are the host's to name; everything visible belongs to the
            section, which on a page heads itself with components.PluginPageHeader above its own
            document surface — the header has to sit ABOVE that surface, so the host cannot supply it
            from out here. In the Settings deck the panel keeps supplying both. */}
        <ModuleHeader title={section.label} icon={pluginLucideIcon(section.icon)}>
          <AutoSaveStatus status={save.status} onRetry={save.retry} />
        </ModuleHeader>
        <MotionReveal>{rendered}</MotionReveal>
      </WorkspacePage>
    ) : settingsComponent && section ? (
      <>
        {/* Nothing but the page name: the header renders no DOM without children, so the masthead and
            the browser tab keep reading the section's label while the section owns every pixel. Its
            save state is its own to show — the host has no header here to put it in, and `onSaveState`
            is still handed to it above so a section that wants the host's channel keeps it. */}
        <ModuleHeader title={section.label} icon={pluginLucideIcon(section.icon)} />
        {rendered}
      </>
    ) : rendered;
  }

  return (
    <ModuleShell moduleId={`plugin-${plugin}`}>
      <PluginErrorBoundary notice={strings.crashed}>{body}</PluginErrorBoundary>
    </ModuleShell>
  );
}
