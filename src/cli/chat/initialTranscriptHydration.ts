import type { BrainMessageView } from '../../brain/messageView.js';
import type { BrainClient } from './brainClient.js';
import { SnapshotTimeoutError } from './snapshotHydrator.js';
import type { SnapshotHydrator } from './snapshotHydrator.js';
import { color } from './theme.js';

/** Hydrate boot history through the application-owned lane. The caller constructs and retains the
 * hydrator; this narrow operation only turns its timeout/retain outcome into the initial notice. */
export async function loadInitialTranscript<E>(
  client: Pick<BrainClient, 'history'>,
  hydrator: SnapshotHydrator<E>,
  lifecycle: AbortSignal,
): Promise<{ history: BrainMessageView[]; notice: string }> {
  let history: BrainMessageView[] = [];
  let notice = '';
  const lane = hydrator.openLane('parent', lifecycle, { onOverflow: () => {} });
  await lane.hydrate(
    (signal) => client.history(undefined, signal),
    {
      commit: (loaded) => { history = loaded; },
      retain: (_replay, error) => {
        notice = color.error(error instanceof SnapshotTimeoutError
          ? 'conversation transcript history timed out'
          : `could not load the conversation transcript: ${error instanceof Error ? error.message : String(error)}`);
      },
    },
  );
  return { history, notice };
}
