'use client';
import { LoadingState } from '../../components/ui/states';
import { useConfig } from '../../lib/queries';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { BrainProvidersSection } from './BrainProvidersSection';
import { BrainRuntimeSection } from './BrainRuntimeSection';

export { modelPickerItems } from './BrainProvidersSection';

/** Settings → Brain composition. Provider accounts and runtime policy keep independent save lifecycles. */
export function BrainSection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void }) {
  const { data: config } = useConfig();

  return (
    <>
      {!config ? <LoadingState /> : null}
      <BrainRuntimeSection config={config} onSaveState={onSaveState} />
      <BrainProvidersSection config={config} />
    </>
  );
}
