'use client';
import { useState, useEffect } from 'react';
import { Sparkles, Pencil, Plus } from 'lucide-react';
import { useMyCliSettings } from '../../lib/queries';
import { useSaveMyCliSettings } from '../../lib/mutations';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { MonacoEditor } from '../projects/editor/monacoLoader';
import { defineEditorThemes } from '../projects/editor/oledTheme';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { SpatialGroup, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { Modal, ModalFooter } from '../../components/ui/Modal';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { Button } from '../../components/ui/Button';
import { Pill } from './pills';

const EDIT_OPTIONS = {
  fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true,
  padding: { top: 12 }, wordWrap: 'on' as const, lineNumbers: 'off' as const, folding: false,
};

/** Per-user personality: how the assistant communicates (a style pill) plus one global instruction body
 *  applied on every surface (web / CLI / Discord / cron). The body is edited in a Monaco modal and shown
 *  as a compact text preview when set. Both live in cli-settings and autosave together. Runtime knobs
 *  (models, thinking level, context) live in the account's Elowen AI section. */
export function PersonalitySection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();

  // Both fields live in cli-settings (shared record with the Elowen AI section); this section owns only
  // the personality-facing fields. The PATCH merges server-side and one autosave covers both — so the
  // body keeps saving whether the editor modal is open or closed.
  const cli = useMyCliSettings();
  const saveCli = useSaveMyCliSettings();
  const [advisorStyle, setAdvisorStyle] = useState('professional');
  const [personalityBody, setPersonalityBody] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (cli.data && !seeded) {
      // Both fields come from an external API that may predate these keys (older daemon build), so treat
      // them as possibly-missing at the runtime boundary and fall back to the defaults.
      setAdvisorStyle(cli.data.advisorStyle || 'professional');
      setPersonalityBody(cli.data.personalityBody ?? '');
      setSeeded(true);
    }
  }, [cli.data, seeded]);
  const save = useAutoSaveStatus([advisorStyle, personalityBody], async () => {
    try { await saveCli.mutateAsync({ advisorStyle, personalityBody }); }
    catch (error) { toast(t.personality.saveError, 'error'); throw error; }
  }, { ready: seeded });
  useEffect(() => {
    onSaveState?.('personality', save.status, save.status === 'error' ? save.retry : undefined);
  }, [onSaveState, save.retry, save.status]);

  const styleOptions = [
    { value: 'professional', label: t.personality.styleProfessional },
    { value: 'friendly', label: t.personality.styleFriendly },
    { value: 'concise', label: t.personality.styleConcise },
    { value: 'detailed', label: t.personality.styleDetailed },
  ];

  const hasBody = personalityBody.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Communication style pills (applied everywhere, on top of the global body) */}
      <SpatialGroup>
        <SpatialRow title={t.personality.styleLabel} icon={Sparkles}>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.personality.styleLabel}>
            {styleOptions.map((o) => (
              <Pill key={o.value} on={advisorStyle === o.value} onClick={() => setAdvisorStyle(o.value)}>{o.label}</Pill>
            ))}
          </div>
        </SpatialRow>
      </SpatialGroup>

      {/* Global personality instructions — edited in a Monaco modal, shown as a compact preview when set */}
      <SpatialGroup>
        <SpatialRow title={t.personality.bodyLabel} description={t.personality.bodyHint} icon={Sparkles}>
          <Button variant="default" icon={hasBody ? Pencil : Plus} onClick={() => setEditing(true)}>
            {hasBody ? t.personality.bodyEdit : t.personality.bodyAdd}
          </Button>
        </SpatialRow>
        {hasBody ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="mt-2.5 block w-full rounded-md border border-border bg-elevated/20 px-3.5 py-3 text-left transition-colors hover:border-border-strong"
            aria-label={t.personality.bodyEdit}
          >
            <span className="line-clamp-4 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-text-muted">{personalityBody}</span>
          </button>
        ) : null}
      </SpatialGroup>

      {editing ? (
        <Modal title={t.personality.bodyLabel} description={t.personality.bodyHint} icon={Sparkles} size="lg" onClose={() => setEditing(false)}>
          <div className="min-h-0 flex-1 overflow-hidden">
            <MonacoEditor
              language="markdown"
              value={personalityBody}
              onChange={(v) => setPersonalityBody(v ?? '')}
              theme="elowen-oled"
              beforeMount={defineEditorThemes}
              height="100%"
              options={{ ...EDIT_OPTIONS, placeholder: t.personality.bodyPlaceholder, ariaLabel: t.personality.bodyLabel }}
            />
          </div>
          <ModalFooter status={<AutoSaveStatus status={save.status} onRetry={save.retry} />}>
            <Button variant="accent" onClick={() => setEditing(false)}>{t.common.done}</Button>
          </ModalFooter>
        </Modal>
      ) : null}
    </div>
  );
}
