'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUserTools } from '../../lib/queries';
import { useUpdateUser } from '../../lib/mutations';
import { useToast } from '../../components/ui/Toast';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { useTranslation } from '../../lib/i18n';
import type { User, UserPatch, UserToolPill } from '../../lib/types';
import { LoadingLine } from '../../components/ui/states';
import { toolLucideIcon } from '../../lib/toolGlyph';

/** The tool's picture, derived from its name. The pill list sits two blocks under a column of monochrome
 *  Lucide icons, so it may not render `tool.icon`: that field is whatever emoji a plugin manifest happens
 *  to declare, and it put a question mark, a laptop and a recycling symbol into the same drawer. */
function Icon({ tool }: { tool: UserToolPill }) {
  const Glyph = toolLucideIcon(tool.name);
  return <Glyph size={13} aria-hidden className="shrink-0" />;
}

/** The user's effective tool access: a compact summary (enabled vs total + plugin count) with a
 *  manage modal grouped by plugin. A checked plugin tool MEANS "in this account's grant"; built-ins
 *  (memory, image) are inherited, fixed, and render as disabled rows.
 *
 *  The account row is the prop rather than a bare id because the save needs the account's RAW
 *  `allowed_tools`/`disabled_tools`, and the row the panel already holds is where they live — asking the
 *  pills route for them too would put the same grant behind two sources of truth. */
export function ToolPills({ user }: { user: User }) {
  const userId = user.id;
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const tools = useUserTools(userId);
  const update = useUpdateUser();
  const [open, setOpen] = useState(false);

  const all = tools.data ?? [];
  if (tools.isLoading) return <LoadingLine layout="inline" />;
  if (all.length === 0) return <p className="text-xs italic text-muted-foreground">{t.users.toolsEmpty}</p>;

  const enabled = all.filter((x) => x.state === 'allowed' || x.state === 'inherited');
  const pluginCount = new Set(all.map((x) => x.plugin).filter(Boolean)).size;

  const groupLabelOf = (x: UserToolPill) =>
    x.plugin ?? (x.group === 'memory' ? t.managePicker.toolGroupMemory : t.managePicker.toolGroupElowen);
  // Two different reasons a row cannot be toggled, and they must not look alike: `inherited` is a
  // built-in everyone has, while `unavailable` is a plugin tool this account was never granted. Showing
  // the latter as "built-in" told the admin the user HAD a tool they cannot run.
  const items: ManageSelectionItem[] = all.map((x) => {
    const ungranted = x.state === 'unavailable';
    const badge = ungranted ? t.managePicker.notGranted : t.managePicker.builtIn;
    const hint = ungranted ? t.managePicker.notGrantedHint : t.managePicker.builtInHint;
    return {
      id: x.name,
      label: x.name,
      group: x.plugin ?? x.group,
      groupLabel: groupLabelOf(x),
      icon: <Icon tool={x} />,
      badges: x.toggleable ? undefined : [{ text: badge, tone: 'muted' as const }],
      disabled: !x.toggleable,
      disabledHint: x.toggleable ? undefined : hint,
    };
  });

  // ONE definition of "checked", used both to seed the modal and to read a save back. When these two
  // drifted apart, an untouched row looked changed and silently entered the deny-list.
  const isChecked = (x: UserToolPill) => x.state !== 'disabled' && x.state !== 'unavailable';

  // The PATCH replaces the grant wholesale, so the save starts from the account's CURRENT grant and
  // applies only the CHANGED toggles. Sending the checked set instead would silently revoke every tool
  // this list cannot show as checked — the `unavailable` ones, whose plugin is disabled or whose MCP
  // server is offline — so toggling a plugin off and on again would quietly cost the account its grant.
  //
  // Checking a tool also clears it from the older deny-list, which is still honoured at turn time: the
  // grant would otherwise be overruled and the box would spring back. Unchecking only shrinks the grant;
  // the deny-list never grows from here, since the grant is now what expresses the admin's "no".
  const handleSave = async (next: Set<string>) => {
    // `['*']` is the pre-migration "unrestricted" marker, not a tool named `*`. Saving converts it to the
    // concrete plugin tools this account can see, exactly as the deploy migration does.
    const wildcard = user.allowed_tools.includes('*');
    const allow = new Set(wildcard ? all.filter((x) => x.group === 'plugin').map((x) => x.name) : user.allowed_tools);
    const deny = new Set(user.disabled_tools);
    let denyChanged = false;
    for (const x of all) {
      if (!x.toggleable) continue;
      const isOn = next.has(x.name);
      if (isOn === isChecked(x)) continue;
      if (isOn) {
        allow.add(x.name);
        denyChanged = deny.delete(x.name) || denyChanged;
      } else allow.delete(x.name);
    }
    const patch: UserPatch = { allowed_tools: [...allow] };
    if (denyChanged) patch.disabled_tools = [...deny];
    try {
      await update.mutateAsync({ id: userId, patch });
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
        manageAriaLabel={t.users.manageTools}
      />
      <ManageSelectionModal
        title={t.users.tools}
        subtitle={t.managePicker.toolsSubtitle}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        // Checked = the account can actually run it. `disabled` is the admin's explicit no; `unavailable`
        // means the plugin was never granted, so a checked box would claim access that does not exist.
        selected={new Set(all.filter(isChecked).map((x) => x.name))}
        onSave={handleSave}
        saving={update.isPending}
        countLabel={(n) => t.managePicker.toolsSelected.replace('{n}', String(n))}
      />
    </>
  );
}
