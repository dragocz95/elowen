'use client';
import { useState, useEffect } from 'react';
import { useAutoSave } from '../../lib/useAutoSave';
import { Search, Save } from 'lucide-react';
import { SettingGroup, SettingRow } from '../../components/ui/SettingsPrimitives';
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
export function AccountMemorySection() {
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
  const persist = () => {
    save.mutate({ autoRecall, autoSave }, { onError: () => toast(t.accountMemory.saveError, 'error') });
  };
  useAutoSave([autoRecall, autoSave], persist, { ready: seeded });

  if (isLoading || !data) return <LoadingState />;

  return (
    <SettingGroup>
      <SettingRow title={t.accountMemory.recallTitle} icon={Search} description={t.help.memoryRecall}>
        <label className="flex items-center gap-3 text-sm text-text">
          <Toggle checked={autoRecall} onChange={setAutoRecall} label={t.accountMemory.recallToggle} />
          <span>{t.accountMemory.recallToggle}</span>
        </label>
      </SettingRow>

      <SettingRow title={t.accountMemory.saveTitle} icon={Save} description={t.help.memorySave}>
        <label className="flex items-center gap-3 text-sm text-text">
          <Toggle checked={autoSave} onChange={setAutoSave} label={t.accountMemory.saveToggle} />
          <span>{t.accountMemory.saveToggle}</span>
        </label>
      </SettingRow>
    </SettingGroup>
  );
}
