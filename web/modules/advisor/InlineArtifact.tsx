'use client';
import { useEffect, useState } from 'react';
import type { PluginUiRegistration } from 'elowen-plugin-ui-kit';
import type { BrainInlineArtifact, PluginUiListing } from '../../lib/types';
import { useTranslation } from '../../lib/i18n';
import { usePluginUi } from '../../lib/queries';
import { loadPluginUi, PLUGIN_UI_API_VERSION } from '../../lib/pluginUi';
import { PluginErrorBoundary, PluginPlaceholder } from '../../components/plugin/PluginUiGuards';

/** Lazily resolve and render one plugin-owned artifact inside the transcript. The artifact fallback is the
 * complete degradation path: missing/unavailable bundles, unknown views and render crashes all stay local to
 * this slot and never affect the surrounding chat.
 *
 * `narration` is the assistant prose the transcript is showing right now (see `liveNarration`). An artifact
 * that expands over the dock hides the conversation it belongs to, so the contract hands it that one
 * bounded string — never the transcript, never a tool payload, never hidden reasoning. */
export function InlineArtifact({ artifact, narration }: { artifact: BrainInlineArtifact; narration?: string }) {
  const { locale } = useTranslation();
  const listing = usePluginUi(locale);
  const entry = listing.data?.find((candidate: PluginUiListing) => candidate.name === artifact.plugin);
  const compatible = entry !== undefined && entry.apiVersion <= PLUGIN_UI_API_VERSION;
  const [registration, setRegistration] = useState<PluginUiRegistration | null | undefined>(undefined);

  useEffect(() => {
    if (!entry || !compatible) return;
    let alive = true;
    setRegistration(undefined);
    void loadPluginUi(entry.name, entry.url, entry.cssUrl)
      .then((value) => { if (alive) setRegistration(value); })
      .catch(() => { if (alive) setRegistration(null); });
    return () => { alive = false; };
  }, [compatible, entry]);

  if (listing.isLoading) return null;
  if (!entry || !compatible || registration === null) return <PluginPlaceholder text={artifact.fallback} />;
  if (registration === undefined) return null;
  if (registration.requiresApiVersion > PLUGIN_UI_API_VERSION) return <PluginPlaceholder text={artifact.fallback} />;

  const Component = registration.chatArtifacts?.[artifact.view];
  if (!Component) return <PluginPlaceholder text={artifact.fallback} />;
  return (
    <div data-testid="chat-inline-artifact" data-plugin={artifact.plugin} data-artifact-id={artifact.id}>
      <PluginErrorBoundary notice={artifact.fallback}>
        <Component plugin={artifact.plugin} artifact={artifact} narration={narration ?? ''} />
      </PluginErrorBoundary>
    </div>
  );
}
