'use client';
import { useState, useEffect } from 'react';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { Search, Save } from 'lucide-react';
import { SpatialGroup, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { Toggle } from '../../components/ui/Toggle';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useMyCliSettings } from '../../lib/queries';
import { useSaveMyCliSettings } from '../../lib/mutations';

/** Account → Memory: per-user memory automation for the embedded brain across web chat, `elowen chat`,
 *  and the user's own verified Discord messages. autoRecall injects the user's most relevant durable
 *  memories under their message before the reply; autoSave lets the post-turn curator persist new
 *  facts to their account. Both default on; read fresh each turn so a flip applies immediately. */
export function AccountMemorySection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void } = {}) {
  const { data, isLoading } = useMyCliSettings();
  const save = useSaveMyCliSettings();
  const { toast } = useToast();
  const { t } = useTranslation();

  const [autoRecall, setAutoRecall] = useState(true);
  const [autoSave, setAutoSave] = useState(true);

  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (data && !seeded) {
      setAutoRecall(data.autoRecall);
      setAutoSave(data.autoSave);
      setSeeded(true);
    }
  }, [data, seeded]);

  // Auto-persist shortly after a toggle. Sends only this section's two fields — the PATCH merges, so
  // the CLI/Personality/Profile picks stay untouched.
  const autosave = useAutoSaveStatus([autoRecall, autoSave], async () => {
    try { await save.mutateAsync({ autoRecall, autoSave }); }
    catch (error) { toast(t.accountMemory.saveError, 'error'); throw error; }
  }, { ready: seeded });
  useEffect(() => onSaveState?.('memory', autosave.status, autosave.retry), [onSaveState, autosave.status, autosave.retry]);

  if (isLoading || !data) return <LoadingState />;

  return (
    <SpatialGroup>
      <SpatialRow title={t.accountMemory.recallTitle} icon={Search} description={t.help.memoryRecall}>
        <label className="flex items-center gap-3 text-sm text-text">
          <Toggle checked={autoRecall} onChange={setAutoRecall} label={t.accountMemory.recallToggle} />
          <span>{t.accountMemory.recallToggle}</span>
        </label>
      </SpatialRow>

      <SpatialRow title={t.accountMemory.saveTitle} icon={Save} description={t.help.memorySave}>
        <label className="flex items-center gap-3 text-sm text-text">
          <Toggle checked={autoSave} onChange={setAutoSave} label={t.accountMemory.saveToggle} />
          <span>{t.accountMemory.saveToggle}</span>
        </label>
      </SpatialRow>
    </SpatialGroup>
  );
}
