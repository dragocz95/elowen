'use client';
import { useMemo, useState } from 'react';
import { Palette } from 'lucide-react';
import { useConfig } from '../../lib/queries';
import { useUpdateConfig } from '../../lib/mutations';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { SettingsRow } from '../../components/ui/SettingsSurface';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { BUILTIN_SKIN, SKIN_CHOICES } from '../../lib/skins';

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

  const label = (name: string): string => (name === BUILTIN_SKIN ? t.common.skinBuiltIn : name);

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
      <SettingsRow label={t.settings.skins.label} description={t.settings.skins.hint} icon={Palette}>
        <SelectionSummary
          countText={chosen.length ? t.managePicker.selectedCount.replace('{n}', String(chosen.length)) : t.settings.skins.none}
          samples={chosen.slice(0, 3).map((name) => ({ label: label(name) }))}
          moreCount={Math.max(0, chosen.length - 3)}
          onManage={() => setOpen(true)}
          manageLabel={t.settings.skins.manage}
          variant="line"
        />
      </SettingsRow>
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
