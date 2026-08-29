'use client';
import { useMemo, useState } from 'react';
import { ChevronDown, Palette } from 'lucide-react';
import { useConfig } from '../../lib/queries';
import { useUpdateConfig } from '../../lib/mutations';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { SettingsRow } from '../../components/ui/SettingsSurface';
import { Button } from '../../components/ui/Button';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SKIN_CHOICES, skinDisplayName, type SkinChoice } from '../../lib/skins';

/** Which designs accounts may switch between, chosen from the skins THIS build compiled. The list is the
 *  whole control: the switcher in the top bar appears only once at least two are allowed, so leaving it
 *  empty — the default — keeps an instance looking exactly as it did before skins were switchable.
 *
 *  Offering the built-in design as an entry rather than an implicit floor is deliberate: allowing one skin
 *  and nothing else would otherwise be a one-way door, with no way back to the plain look. */
export function SkinsRow() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const config = useConfig();
  const update = useUpdateConfig();
  const [open, setOpen] = useState(false);

  const allowed = useMemo(() => {
    const stored = config.data?.allowedSkins ?? [];
    // Intersect with what this build actually has: a name left behind by a deployment that used to ship a
    // skin must not be presented as a live selection.
    return new Set(stored.filter((name) => (SKIN_CHOICES as readonly string[]).includes(name)));
  }, [config.data?.allowedSkins]);

  const label = (name: SkinChoice): string => skinDisplayName(t, name);

  const items: ManageSelectionItem[] = SKIN_CHOICES.map((name) => ({
    id: name,
    label: label(name),
    group: 'skins',
    groupLabel: t.settings.skins.label,
  }));

  const save = async (next: Set<string>): Promise<void> => {
    // Send them in the catalog's own order rather than Set insertion order: this list is also the order
    // the switcher cycles through, and it should not depend on which checkbox the admin happened to tick
    // first.
    const ordered = SKIN_CHOICES.filter((name) => next.has(name));
    try {
      await update.mutateAsync({ allowedSkins: [...ordered] });
      setOpen(false);
    } catch {
      toast(t.settings.skins.saveError, 'error');
    }
  };

  const chosen = SKIN_CHOICES.filter((name) => allowed.has(name));

  return (
    <>
      {/* ONE control, the width of the record's trailing cell. It used to be a `SelectionSummary`: a count
       *  line above up to three name chips and a "+N", with the manage button beside them — four lines of
       *  content in a cell that is one grid row tall, so the record wrapped and its value ended up under
       *  its own label. The chips also named skins the reader cannot see from here, which is what the
       *  dialog behind this button is for. The count IS the summary. */}
      <SettingsRow
        label={t.settings.skins.label}
        description={t.settings.skins.hint}
        icon={Palette}
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
            className="w-full justify-between font-normal"
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
        saving={update.isPending}
        countLabel={(n) => t.managePicker.selectedCount.replace('{n}', String(n))}
        emptySelectionHint={t.settings.skins.emptyHint}
      />
    </>
  );
}
