'use client';
import { Fragment, useState, type ReactNode } from 'react';
import { Link2 } from 'lucide-react';
import { SpatialRow } from '../../components/ui/SpatialPrimitives';
import { LinkedAccountRow } from '../../components/ui/LinkedAccountRow';
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

/** Every identity this account owns elsewhere, as one row that opens a drawer rather than a column of
 *  bare text boxes. A chat platform reports a sender id and the account claims it by pasting that id; a
 *  plugin connector brings its own panel. Either way the question is "which of these am I" — a job for a
 *  summary, with the claiming behind one click.
 *
 *  Only platforms the daemon reports as live are offered: a field for a channel this instance is not
 *  connected to can never match an incoming sender. With neither a live platform nor a connector the row
 *  disappears entirely instead of presenting an empty control that explains nothing. */
export function PlatformLinksCard({ available, values, onChange, connectors = [] }: {
  available: PlatformLinkKey[];
  values: Partial<Record<PlatformLinkKey, string>>;
  onChange: (key: PlatformLinkKey, value: string) => void;
  /** Identities a PLUGIN owns, contributed through its `web.account` entries declaring
   *  `placement: 'linkedAccount'`. They are the same question as the rows above — "which account am I
   *  over there" — so they belong behind the same one click rather than each as its own top-level menu.
   *  The host renders the panel and knows nothing about what it connects to.
   *
   *  `chip` is how a connector appears in the closed summary beside the chat platforms. The host cannot
   *  compute it — whether an OAuth connector is currently linked is a question only the plugin can
   *  answer — so the plugin contributes the chip and renders nothing when it is not connected. Without
   *  it a linked GitHub was invisible until the drawer was opened, while Discord announced itself. */
  connectors?: { id: string; node: ReactNode; chip?: ReactNode }[];
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
  // The row survives on plugin connectors alone: an instance connected to no chat platform can still own
  // a GitHub identity, and hiding the whole row would leave that connector unreachable.
  if (shown.length === 0 && connectors.length === 0) return null;
  const linked = shown.filter((key) => (values[key] ?? '').trim().length > 0);

  return (
    <>
      {/* WHICH identities are claimed is the record's value, and a stack of brand marks says it in the
          width a status has: one line, no wrap, no card of its own. The names ride along as the stack's
          accessible text, so a screen reader hears the platforms rather than a row of decorations.
          The empty sentence speaks only for the chat platforms it can actually count — with none of them
          offered it would be a claim about an empty set sitting over a connector that may well be
          linked. */}
      <SpatialRow
        title={t.account.linkedAccounts}
        icon={Link2}
        description={t.help.accountPlatformLinks}
        status={(
          <span className="flex min-w-0 items-center gap-1.5">
            {linked.map((key) => (
              <span key={key} className="flex shrink-0 items-center" title={copy[key].title}>
                <PlatformIcon platform={PLATFORM_LINK_INPUTS[key].platform} size={14} />
                <span className="sr-only">{copy[key].title}</span>
              </span>
            ))}
            {connectors.map((connector) => <Fragment key={connector.id}>{connector.chip}</Fragment>)}
            {shown.length > 0 && linked.length === 0 ? <span className="truncate">{t.account.linkedAccountsNone}</span> : null}
          </span>
        )}
        control={(
          <button
            type="button"
            className="spatial-inline-action"
            aria-label={t.account.linkedAccounts}
            onClick={() => setOpen(true)}
          >
            <Link2 size={14} aria-hidden />{t.managePicker.manage}
          </button>
        )}
      />
      {open ? (
        /* The rail's header names the surface and the row carries the explanation, so the body opens on
           the fields themselves. */
        <WorkspaceDetailRail label={t.account.linkedAccounts} closeLabel={t.common.close} onClose={() => setOpen(false)}>
          <div className="flex flex-col divide-y divide-border">
            {shown.map((key) => {
              const value = values[key] ?? '';
              return (
                <LinkedAccountRow
                  key={key}
                  icon={<PlatformIcon platform={PLATFORM_LINK_INPUTS[key].platform} size={18} />}
                  title={copy[key].title}
                  /* Disconnecting only clears the field, so it needs no confirmation — but it stays a
                     quiet ghost until hovered, because it is the one action in this row nobody is
                     looking for. It appears only when there is something to disconnect. */
                  actions={value ? <Button variant="ghost-danger" onClick={() => onChange(key, '')}>{t.account.linkDisconnect}</Button> : null}
                  description={copy[key].description}
                >
                  <Input
                    value={value}
                    onChange={(e) => onChange(key, e.target.value)}
                    placeholder={PLATFORM_LINK_INPUTS[key].placeholder}
                    className="font-mono"
                    aria-label={copy[key].title}
                  />
                </LinkedAccountRow>
              );
            })}
            {/* A plugin's own identity panel, rendered whole as one more row. The host gives it the
                divider and nothing else: what "connected" means, and every action that changes it, stay
                entirely the plugin's. The padding is NOT the host's here — the plugin builds its row out
                of the same LinkedAccountRow as the platforms above, which carries its own, and a wrapper
                adding more would make the connector the one row sitting lower than its neighbours. */}
            {connectors.map((connector) => (
              <div key={connector.id}>{connector.node}</div>
            ))}
          </div>
        </WorkspaceDetailRail>
      ) : null}
    </>
  );
}
