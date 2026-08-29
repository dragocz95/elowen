'use client';
import { useState, useEffect } from 'react';
import { Sparkles, Pencil } from 'lucide-react';
import { useMyCliSettings } from '../../lib/queries';
import { useSaveMyCliSettings } from '../../lib/mutations';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { MonacoEditor } from '../../lib/monaco/monacoLoader';
import { defineEditorThemes, editorTheme } from '../../lib/monaco/oledTheme';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { SpatialGroup, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { Modal, ModalFooter } from '../../components/ui/Modal';
import { ChoiceField } from '../../components/ui/ChoiceField';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { Button } from '../../components/ui/Button';
import { LoadingState, ErrorState } from '../../components/ui/states';

const EDIT_OPTIONS = {
  fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true,
  padding: { top: 12 }, wordWrap: 'on' as const, lineNumbers: 'off' as const, folding: false,
};

/** Per-user communication style plus global instructions for how the agent should work with this account.
 *  The instructions apply on every surface (web / CLI / Discord / cron), are edited in a Monaco modal and
 *  autosave with the style. Runtime knobs live in the account's Elowen AI section. */
export function PersonalitySection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();

  // Both fields live in cli-settings. The PATCH merges server-side and one autosave covers both, so the
  // instructions keep saving whether the editor modal is open or closed.
  const cli = useMyCliSettings();
  const saveCli = useSaveMyCliSettings();
  const [advisorStyle, setAdvisorStyle] = useState('professional');
  const [userInstructions, setUserInstructions] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (cli.data && !seeded) {
      // Both fields come from an external API that may predate these keys (older daemon build), so treat
      // them as possibly-missing at the runtime boundary and fall back to the defaults.
      setAdvisorStyle(cli.data.advisorStyle || 'professional');
      setUserInstructions(cli.data.userInstructions ?? cli.data.personalityBody ?? '');
      setSeeded(true);
    }
  }, [cli.data, seeded]);
  const save = useAutoSaveStatus([advisorStyle, userInstructions], async () => {
    try { await saveCli.mutateAsync({ advisorStyle, userInstructions }); }
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

  // Both fields come from cli-settings, so a failed load must not render the editor at all — with no
  // data seeded, editing here would look live while the autosave (`ready: seeded`) can never fire.
  if (cli.isError) return <ErrorState message={t.common.daemonUnreachable} onRetry={() => cli.refetch()} />;
  if (cli.isLoading || !cli.data) return <LoadingState />;

  const hasInstructions = userInstructions.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      <SpatialGroup>
        {/* Four choices is past what a segmented track can hold in a record's trailing cell, so the field
            shows the current style and picks in the shared searchable picker. */}
        <SpatialRow
          title={t.personality.styleLabel}
          icon={Sparkles}
          control={<ChoiceField title={t.personality.styleLabel} options={styleOptions} value={advisorStyle} onChange={setAdvisorStyle} />}
        />
        {/* Global user instructions. The first words are the record's value — a short trailing string the
            row ellipses — and the button that opens the Monaco editor is its one control. */}
        <SpatialRow
          title={t.personality.bodyLabel}
          description={t.personality.bodyHint}
          icon={Pencil}
          status={hasInstructions ? <span title={userInstructions.trim()}>{userInstructions.trim().slice(0, 42)}</span> : undefined}
          control={(
            <button
              type="button"
              className="spatial-inline-action"
              aria-label={t.personality.bodyLabel}
              onClick={() => setEditing(true)}
            >
              <Pencil size={14} aria-hidden />{hasInstructions ? t.personality.bodyEdit : t.personality.bodyAdd}
            </button>
          )}
        />
      </SpatialGroup>

      {editing ? (
        <Modal title={t.personality.bodyLabel} description={t.personality.bodyHint} icon={Sparkles} size="lg" onClose={() => setEditing(false)}>
          <div className="min-h-0 flex-1 overflow-hidden">
            <MonacoEditor
              language="markdown"
              value={userInstructions}
              onChange={(v) => setUserInstructions(v ?? '')}
              theme={editorTheme()}
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
