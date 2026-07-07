'use client';
import { useState } from 'react';
import { Wrench } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useUserTools } from '../../lib/queries';
import { useUpdateUser } from '../../lib/mutations';
import { useToast } from '../../components/ui/Toast';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { useTranslation } from '../../lib/i18n';
import type { UserToolPill } from '../../lib/types';

function Icon({ tool }: { tool: UserToolPill }) {
  return <span aria-hidden className="shrink-0 text-[13px] leading-none">{tool.icon ?? <Wrench size={12} className="inline" />}</span>;
}

/** The user's effective tool access: a compact summary (enabled vs total + plugin count) with a
 *  manage modal grouped by plugin. Plugin tools toggle on/off for THIS user's own brain sessions;
 *  built-ins (memory, control-plane) are fixed and render as disabled rows. */
export function ToolPills({ userId }: { userId: number }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const tools = useUserTools(userId);
  const update = useUpdateUser();
  const [open, setOpen] = useState(false);

  const all = tools.data ?? [];
  if (tools.isLoading) return <p className="text-xs text-text-muted">…</p>;
  if (all.length === 0) return <p className="text-xs italic text-text-muted">{t.users.toolsEmpty}</p>;

  const enabled = all.filter((x) => x.state === 'allowed' || x.state === 'inherited');
  const pluginCount = new Set(all.map((x) => x.plugin).filter(Boolean)).size;

  const groupLabelOf = (x: UserToolPill) =>
    x.plugin ?? (x.group === 'memory' ? t.managePicker.toolGroupMemory : t.managePicker.toolGroupOrca);
  const items: ManageSelectionItem[] = all.map((x) => ({
    id: x.name,
    label: x.name,
    group: x.plugin ?? x.group,
    groupLabel: groupLabelOf(x),
    icon: <Icon tool={x} />,
    badges: x.toggleable ? undefined : [{ text: t.managePicker.builtIn, tone: 'muted' as const }],
    disabled: !x.toggleable,
    disabledHint: x.toggleable ? undefined : t.managePicker.builtInHint,
  }));

  // The PATCH replaces the deny-list wholesale. Start from the current deny-set (exactly the
  // toggleable tools reported `disabled`) and apply only the CHANGED toggles, so tools the admin
  // didn't touch (e.g. `unavailable` ones) keep their current membership.
  const handleSave = async (next: Set<string>) => {
    const deny = new Set(all.filter((x) => x.toggleable && x.state === 'disabled').map((x) => x.name));
    for (const x of all) {
      if (!x.toggleable) continue;
      const wasOn = x.state !== 'disabled';
      const isOn = next.has(x.name);
      if (isOn === wasOn) continue;
      if (isOn) deny.delete(x.name); else deny.add(x.name);
    }
    try {
      await update.mutateAsync({ id: userId, patch: { disabled_tools: [...deny] } });
      qc.invalidateQueries({ queryKey: ['user-tools', userId] });
    } catch (e) {
      toast(String(e) || t.users.updateError, 'error');
      throw e;
    }
  };

  return (
    <>
      <SelectionSummary
        countText={t.managePicker.toolsCount
          .replace('{n}', String(enabled.length))
          .replace('{total}', String(all.length))
          .replace('{p}', String(pluginCount))}
        samples={enabled.slice(0, 3).map((x) => ({ label: x.name, icon: <Icon tool={x} /> }))}
        moreCount={Math.max(0, enabled.length - 3)}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
      />
      <ManageSelectionModal
        title={t.users.tools}
        subtitle={t.managePicker.toolsSubtitle}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        // Checked = "not in the deny-list" (state !== disabled), mirroring what a save computes —
        // so an untouched `unavailable` tool round-trips without silently entering the deny-list.
        selected={new Set(all.filter((x) => x.state !== 'disabled').map((x) => x.name))}
        onSave={handleSave}
        saving={update.isPending}
        countLabel={(n) => t.managePicker.toolsSelected.replace('{n}', String(n))}
      />
    </>
  );
}
