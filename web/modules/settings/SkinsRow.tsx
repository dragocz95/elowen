'use client';
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Palette } from 'lucide-react';
import { useConfig } from '../../lib/queries';
import { useUpdateConfig } from '../../lib/mutations';
import { useAutoSaveStatus } from '../../lib/useAutoSaveStatus';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { useTranslation } from '../../lib/i18n';
import { SettingsRow } from '../../components/ui/SettingsSurface';
import { Button } from '../../components/ui/Button';
import { ROW_TRIGGER_CLASS } from '../../components/ui/RowPicker';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SKINS, skinDisplayName, type SkinName } from '../../lib/skins';
import { rowAnchor } from '../../lib/rowAnchors';

/** Which designs accounts may switch between, chosen from the two skins THIS build compiled. */
export function SkinsRow() {
  const { t } = useTranslation();
  const config = useConfig();
  const update = useUpdateConfig();
  const [open, setOpen] = useState(false);
  const [allowedNames, setAllowedNames] = useState<string[]>([]);
  const [seeded, setSeeded] = useState(false);

  const seed = useMemo(() => {
    const stored = config.data?.allowedSkins ?? [];
    // Intersect with what this build actually has: a name left behind by a deployment that used to ship a
    // skin must not be presented as a live selection.
    return stored.filter((name) => (SKINS as readonly string[]).includes(name));
  }, [config.data?.allowedSkins]);
  useEffect(() => {
    if (config.data && !seeded) { setAllowedNames(seed); setSeeded(true); }
  }, [config.data, seed, seeded]);
  const allowed = useMemo(() => new Set(allowedNames), [allowedNames]);
  const skinSave = useAutoSaveStatus([allowedNames], async () => {
    const ordered = SKINS.filter((name) => allowed.has(name));
    const saved = await update.mutateAsync({ allowedSkins: [...ordered] });
    const canonical = (saved.allowedSkins ?? []).filter((name) => (SKINS as readonly string[]).includes(name));
    if (canonical.join('\u0000') !== ordered.join('\u0000')) setAllowedNames(canonical);
  }, { ready: seeded });

  const label = (name: SkinName): string => skinDisplayName(t, name);

  const items: ManageSelectionItem[] = SKINS.map((name) => ({
    id: name,
    label: label(name),
    group: 'skins',
    groupLabel: t.settings.skins.label,
  }));

  const save = (next: Set<string>): void => {
    // The picker commits only its local selection. The ordinary allowlist edit then follows the shared
    // autosave lifecycle, so failure remains visible and retryable on the row.
    setAllowedNames(SKINS.filter((name) => next.has(name)));
  };

  const chosen = SKINS.filter((name) => allowed.has(name));

  return (
    <>
      {/* ONE control, the width of the record's trailing cell. It used to be a `SelectionSummary`: a count
       *  line above up to three name chips and a "+N", with the manage button beside them — four lines of
       *  content in a cell that is one grid row tall, so the record wrapped and its value ended up under
       *  its own label. The chips also named skins the reader cannot see from here, which is what the
       *  dialog behind this button is for. The count IS the summary. */}
      <SettingsRow
        label={t.settings.skins.label}
        rowId={rowAnchor('settings.skins.label')}
        description={t.settings.skins.hint}
        icon={Palette}
        status={<AutoSaveStatus status={skinSave.status} onRetry={skinSave.retry} />}
        control={(
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t.settings.skins.manage}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            // The canonical hook every row picker carries. Studio's narrowest container query
            // (skins/studio/surfaces.css) trades a trigger's inline padding for its label below 22rem,
            // and it addresses `[data-row-picker]` — without it this one control kept full padding while
            // every other picker in the same column gave it up, and its label truncated instead.
            data-row-picker
            className={ROW_TRIGGER_CLASS}
          >
            <span className="min-w-0 truncate text-left">
              {chosen.length ? t.managePicker.selectedCount.replace('{n}', String(chosen.length)) : t.settings.skins.none}
            </span>
            <ChevronDown size={14} aria-hidden className="opacity-60" />
          </Button>
        )}
      />
      <ManageSelectionModal
        title={t.settings.skins.label}
        subtitle={t.settings.skins.hint}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={allowed}
        onSave={save}
        saving={skinSave.status === 'saving'}
        countLabel={(n) => t.managePicker.selectedCount.replace('{n}', String(n))}
        emptySelectionHint={t.settings.skins.emptyHint}
      />
    </>
  );
}
