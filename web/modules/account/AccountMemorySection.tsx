'use client';
import { useState, useEffect } from 'react';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { Search, Save } from 'lucide-react';
import { SpatialGroup, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { Toggle } from '../../components/ui/Toggle';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useMyCliSettings } from '../../lib/queries';
import { useSaveMyCliSettings } from '../../lib/mutations';
import { rowAnchor } from '../../lib/rowAnchors';

/** Account → Memory: per-user memory automation for the embedded brain across web chat, `elowen chat`,
 *  and the user's own verified Discord messages. autoRecall injects the user's most relevant durable
 *  memories under their message before the reply; autoSave lets the post-turn curator persist new
 *  facts to their account. Both default on; read fresh each turn so a flip applies immediately. */
export function AccountMemorySection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void } = {}) {
  const { data, isLoading, isError, refetch } = useMyCliSettings();
  const save = useSaveMyCliSettings();
  const { toast } = useToast();
  const { t } = useTranslation();

  const [autoRecall, setAutoRecall] = useState(true);
  const [autoLiveRecall, setAutoLiveRecall] = useState(true);
  const [autoSave, setAutoSave] = useState(true);

  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (data && !seeded) {
      setAutoRecall(data.autoRecall);
      setAutoLiveRecall(data.autoLiveRecall);
      setAutoSave(data.autoSave);
      setSeeded(true);
    }
  }, [data, seeded]);

  // Auto-persist shortly after a toggle. Sends only this section's two fields — the PATCH merges, so
  // the CLI/Personality/Profile picks stay untouched.
  const autosave = useAutoSaveStatus([autoRecall, autoLiveRecall, autoSave], async () => {
    try { await save.mutateAsync({ autoRecall, autoLiveRecall, autoSave }); }
    catch (error) { toast(t.accountMemory.saveError, 'error'); throw error; }
  }, { ready: seeded });
  useEffect(() => onSaveState?.('memory', autosave.status, autosave.retry), [onSaveState, autosave.status, autosave.retry]);

  if (isError) return <ErrorState message={t.common.daemonUnreachable} onRetry={() => refetch()} />;
  if (isLoading || !data) return <LoadingState />;

  return (
    <SpatialGroup columns={2}>
      <SpatialRow title={t.accountMemory.recallTitle} rowId={rowAnchor('accountMemory.recallTitle')} icon={Search} description={t.help.memoryRecall}>
        <label className="flex items-center gap-3 text-sm text-foreground">
          <Toggle checked={autoRecall} onChange={setAutoRecall} label={t.accountMemory.recallToggle} />
          <span>{t.accountMemory.recallToggle}</span>
        </label>
      </SpatialRow>

      <SpatialRow title={t.accountMemory.liveRecallTitle} rowId={rowAnchor('accountMemory.liveRecallTitle')} icon={Search} description={t.help.memoryLiveRecall}>
        <label className="flex items-center gap-3 text-sm text-foreground">
          <Toggle checked={autoLiveRecall} onChange={setAutoLiveRecall} label={t.accountMemory.liveRecallToggle} />
          <span>{t.accountMemory.liveRecallToggle}</span>
        </label>
      </SpatialRow>

      <SpatialRow title={t.accountMemory.saveTitle} rowId={rowAnchor('accountMemory.saveTitle')} icon={Save} description={t.help.memorySave}>
        <label className="flex items-center gap-3 text-sm text-foreground">
          <Toggle checked={autoSave} onChange={setAutoSave} label={t.accountMemory.saveToggle} />
          <span>{t.accountMemory.saveToggle}</span>
        </label>
      </SpatialRow>
    </SpatialGroup>
  );
}
