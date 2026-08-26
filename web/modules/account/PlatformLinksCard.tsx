'use client';
import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { SpatialRow } from '../../components/ui/SpatialPrimitives';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { PlatformIcon } from '../../components/ui/PlatformIcon';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { useTranslation } from '../../lib/i18n';
import type { PlatformLinkKey, PlatformSurface } from '../../lib/types';

/** How each platform link presents itself. A `Record` over the daemon's link keys, so it is EXHAUSTIVE
 *  by type: a platform added to the identity descriptors fails this build until it has an entry here.
 *  The keys are spelled out rather than imported because the descriptor module is daemon runtime code
 *  and this app takes TYPES only from `src/` — the type is what enforces the set, not the spelling.
 *
 *  The mark is the platform's own, drawn by {@link PlatformIcon} from `public/platforms/` — the same
 *  brand asset the activity feed and the session list already use, so one identity is one logo across
 *  the app. `platform` is typed rather than spelled free-hand, so a link key can only ever point at a
 *  platform the daemon actually knows. */
const PLATFORM_LINK_INPUTS: Record<PlatformLinkKey, { placeholder: string; platform: PlatformSurface }> = {
  discordUserId: { placeholder: '123456789012345678', platform: 'discord' },
  msteamsUserId: { placeholder: '00000000-0000-0000-0000-000000000000', platform: 'msteams' },
  telegramUserId: { placeholder: '123456789', platform: 'telegram' },
  whatsappNumber: { placeholder: '420778433908', platform: 'whatsapp' },
};
/** Render and save order — the declaration order above, never a second list to keep in step. */
export const PLATFORM_LINK_ORDER = Object.keys(PLATFORM_LINK_INPUTS) as PlatformLinkKey[];

/** The account's chat identities, as one row that opens a drawer rather than a column of bare text
 *  boxes. Each platform reports a sender id and the account claims it by pasting that id, so what the
 *  row has to answer at a glance is "which of these am I reachable as" — a job for a summary of linked
 *  platforms, with the editing behind one click.
 *
 *  Only platforms the daemon reports as live are offered: a field for a channel this instance is not
 *  connected to can never match an incoming sender. With none of them live the row disappears entirely
 *  instead of presenting an empty control that explains nothing. */
export function PlatformLinksCard({ available, values, onChange }: {
  available: PlatformLinkKey[];
  values: Partial<Record<PlatformLinkKey, string>>;
  onChange: (key: PlatformLinkKey, value: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Presentation is a Record over the link keys for the same reason as the inputs above: a new platform
  // is a compile error here until it has a label and a help text, never a silently missing row.
  const copy: Record<PlatformLinkKey, { title: string; description: string }> = {
    discordUserId: { title: t.account.discordId, description: t.help.accountDiscordId },
    msteamsUserId: { title: t.account.msteamsIdentity, description: t.help.accountMsteamsIdentity },
    telegramUserId: { title: t.account.telegramId, description: t.help.accountTelegramId },
    whatsappNumber: { title: t.account.whatsappNumber, description: t.help.accountWhatsappNumber },
  };
  const shown = PLATFORM_LINK_ORDER.filter((key) => available.includes(key));
  if (shown.length === 0) return null;
  const linked = shown.filter((key) => (values[key] ?? '').trim().length > 0);

  return (
    <>
      <SpatialRow title={t.account.linkedAccounts} icon={Link2} description={t.help.accountPlatformLinks}>
        <SelectionSummary
          countText={linked.length === 0 ? t.account.linkedAccountsNone : ''}
          samples={linked.map((key) => ({
            label: copy[key].title,
            icon: <PlatformIcon platform={PLATFORM_LINK_INPUTS[key].platform} size={12} />,
          }))}
          moreCount={0}
          onManage={() => setOpen(true)}
          manageLabel={t.managePicker.manage}
          manageAriaLabel={t.account.linkedAccounts}
        />
      </SpatialRow>
      {open ? (
        <WorkspaceDetailRail label={t.account.linkedAccounts} closeLabel={t.common.close} onClose={() => setOpen(false)}>
          <p className="mb-4 text-xs leading-relaxed text-text-muted">{t.help.accountPlatformLinks}</p>
          <div className="flex flex-col divide-y divide-border">
            {shown.map((key) => {
              const value = values[key] ?? '';
              return (
                <div key={key} className="py-3.5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center"><PlatformIcon platform={PLATFORM_LINK_INPUTS[key].platform} size={18} /></span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{copy[key].title}</span>
                    {/* Disconnecting only clears the field, so it needs no confirmation — but it stays a
                        quiet ghost until hovered, because it is the one action in this row nobody is
                        looking for. It appears only when there is something to disconnect. */}
                    {value ? (
                      <Button variant="ghost-danger" onClick={() => onChange(key, '')}>{t.account.linkDisconnect}</Button>
                    ) : null}
                  </div>
                  <Input
                    value={value}
                    onChange={(e) => onChange(key, e.target.value)}
                    placeholder={PLATFORM_LINK_INPUTS[key].placeholder}
                    className="mt-2 font-mono"
                    aria-label={copy[key].title}
                  />
                  <p className="mt-2 text-xs leading-relaxed text-text-muted">{copy[key].description}</p>
                </div>
              );
            })}
          </div>
        </WorkspaceDetailRail>
      ) : null}
    </>
  );
}
