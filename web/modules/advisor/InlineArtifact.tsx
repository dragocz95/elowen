'use client';
import { useEffect, useState } from 'react';
import type { PluginChatPendingInput, PluginUiRegistration } from 'elowen-plugin-ui-kit';
import type { BrainInlineArtifact, PluginUiListing } from '../../lib/types';
import { useTranslation } from '../../lib/i18n';
import { usePluginUi } from '../../lib/queries';
import { loadPluginUi, PLUGIN_UI_API_VERSION } from '../../lib/pluginUi';
import { PluginErrorBoundary, PluginPlaceholder } from '../../components/plugin/PluginUiGuards';

/** Lazily resolve and render one plugin-owned artifact inside the transcript. The artifact fallback is the
 * complete degradation path: missing/unavailable bundles, unknown views and render crashes all stay local to
 * this slot and never affect the surrounding chat.
 *
 * `narration` is the assistant prose the transcript is showing right now (see `liveNarration`), and
 * `pendingInput` says that the host is waiting on an answer, with the callback that brings its own
 * question card back into view. An artifact that expands over the dock hides both, so the contract hands
 * it one bounded string and one label-plus-callback — never the transcript, never a tool payload, never
 * hidden reasoning, and never the question's options or answer shape. */
export function InlineArtifact({ artifact, narration, pendingInput }: {
  artifact: BrainInlineArtifact;
  narration?: string;
  pendingInput?: PluginChatPendingInput | null;
}) {
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
        <Component plugin={artifact.plugin} artifact={artifact} narration={narration ?? ''} pendingInput={pendingInput ?? null} />
      </PluginErrorBoundary>
    </div>
  );
}
