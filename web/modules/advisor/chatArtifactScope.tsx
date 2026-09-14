'use client';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { PluginChatPendingInput } from 'elowen-plugin-ui-kit';
import type { BrainInlineArtifact } from '../../lib/types';

/** Where inline plugin artifacts get their state — and, just as importantly, where they DON'T.
 *
 *  An artifact needs three things the transcript owns: the open artifacts (to find its own), the prose the
 *  assistant is saying right now, and whether the host is waiting on an answer. Handing those to every
 *  turn as props is what made a settled turn from an hour ago a dependent of the live stream: `narration`
 *  changes on every streamed token, so every row's props changed on every token and no memo could hold.
 *  In a long conversation that is the whole transcript being reconciled tens of times a second, which is
 *  the work a keystroke then has to wait behind.
 *
 *  Two contexts rather than one, because the two halves move at completely different speeds:
 *
 *   - `ArtifactsContext` — the open artifacts. Changes when a plugin opens, updates or closes one, which
 *     is rare. Read by the per-segment slot, of which there is one per tool group.
 *   - `ArtifactLiveContext` — narration and the pending-input notice. Changes on every token, and is read
 *     ONLY inside a mounted artifact. Nothing else in the transcript subscribes, so nothing else renders.
 *
 *  Context deliberately, not props: it reaches past the memo boundary on the rows without taking the rows
 *  along with it. */

interface ArtifactsValue { artifacts: readonly BrainInlineArtifact[] }
interface ArtifactLiveValue { narration?: string; pendingInput?: PluginChatPendingInput | null }

const NO_ARTIFACTS: readonly BrainInlineArtifact[] = [];
const ArtifactsContext = createContext<ArtifactsValue>({ artifacts: NO_ARTIFACTS });
const ArtifactLiveContext = createContext<ArtifactLiveValue>({});

/** The artifacts attached to one tool group, in the order they were opened. */
export function useSegmentArtifacts(toolCallIds: readonly (string | undefined)[]): BrainInlineArtifact[] {
  const { artifacts } = useContext(ArtifactsContext);
  return artifacts.filter((artifact) => toolCallIds.includes(artifact.toolCallId));
}

/** The live half, for a mounted artifact only. */
export function useArtifactLive(): ArtifactLiveValue {
  return useContext(ArtifactLiveContext);
}

/** Publish both halves around a transcript. One surface, one scope — a phone with the dock open on /chat
 *  mounts two surfaces, and each hands its own artifacts its own question card. */
export function ChatArtifactScope({ artifacts, narration, pendingInput, children }: {
  artifacts: readonly BrainInlineArtifact[];
  narration?: string;
  pendingInput?: PluginChatPendingInput | null;
  children: ReactNode;
}) {
  const attached = useMemo<ArtifactsValue>(() => ({ artifacts }), [artifacts]);
  const live = useMemo<ArtifactLiveValue>(() => ({ narration, pendingInput }), [narration, pendingInput]);
  return (
    <ArtifactsContext.Provider value={attached}>
      <ArtifactLiveContext.Provider value={live}>{children}</ArtifactLiveContext.Provider>
    </ArtifactsContext.Provider>
  );
}
