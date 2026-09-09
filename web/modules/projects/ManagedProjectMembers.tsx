'use client';
import { useState } from 'react';
import { apiErrorMessage } from '../../lib/elowenClient';
import { useMe, useProjectMemberProfiles, useUsers } from '../../lib/queries';
import { useAssignProject } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';
import type { Project, ProjectMemberView } from '../../lib/types';
import { managedProjectStrings } from './managedProjectStrings';
import { Avatar } from '../../components/ui/Avatar';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { HelpTip } from '../../components/ui/HelpTip';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { ErrorState, LoadingState } from '../../components/ui/states';

/** What to call a member: the display name when the account has one, the handle otherwise. */
const labelOf = (member: ProjectMemberView) => member.name.trim() || member.username;

/** The member's second line: the handle and the address that tell two similar names apart. */
const detailOf = (member: ProjectMemberView) => [`@${member.username}`, member.email].filter(Boolean).join(' · ');

export function ManagedProjectMembers({ project }: { project: Project }) {
  const { locale, t } = useTranslation();
  const s = managedProjectStrings[locale];
  const me = useMe();
  // The identity view of the membership: this tab is where a member sees WHO shares the environment,
  // so it opts into the profile projection rather than the endpoint's default id list.
  const members = useProjectMemberProfiles(project.id);
  const assign = useAssignProject();
  const actor = me.data?.user;
  const isAdmin = actor?.is_admin === true;
  // `GET /users` is the instance directory and is admin-only on the daemon. A member with the sharing
  // grant therefore never requests it and adds by account id instead; the picker is the administrator's
  // path, so sharing a project can never become a way to enumerate everyone on the instance.
  const directory = useUsers(isAdmin);
  const [inviteId, setInviteId] = useState('');
  const [picking, setPicking] = useState(false);
  const [change, setChange] = useState<{ userId: number; label: string; currentlyAssigned: boolean } | null>(null);

  if (me.isError || members.isError) {
    return <ErrorState message={apiErrorMessage(me.error ?? members.error)} onRetry={() => { void me.refetch(); void members.refetch(); }} />;
  }
  if (me.isLoading || members.isLoading) return <LoadingState variant="list" />;

  const rows = members.data ?? [];
  const memberIds = new Set(rows.map((member) => member.id));
  const canInvite = isAdmin || actor?.can_share_projects === true;
  const busy = assign.isPending || project.lifecycle === 'deleting';
  const validInvite = /^\d+$/.test(inviteId) && Number.isSafeInteger(Number(inviteId)) && Number(inviteId) > 0 && !memberIds.has(Number(inviteId));
  // Administrators hold access to every project without an assignment row, so listing them as
  // candidates would offer a grant that changes nothing.
  const candidates = (directory.data ?? []).filter((user) => !user.is_admin && !memberIds.has(user.id));
  const items: ManageSelectionItem[] = candidates.map((user) => ({
    id: String(user.id),
    label: user.name || user.username,
    badges: [
      { text: `@${user.username}`, tone: 'muted' as const },
      ...(user.email ? [{ text: user.email, tone: 'muted' as const }] : []),
    ],
    group: 'accounts',
    groupLabel: s.accountsGroup,
    icon: <Avatar user={user} size={18} />,
  }));

  // Additions only. Removal stays on the row that shows the person, so each control does one job and
  // both write through the same membership mutation.
  const addMembers = async (next: Set<string>) => {
    const chosen = candidates.filter((user) => next.has(String(user.id)));
    // Sequential: a partial failure stops instead of fanning out further grants, and the refreshed list
    // then shows exactly which ones landed.
    for (const user of chosen) {
      try { await assign.mutateAsync({ userId: user.id, projectId: project.id, currentlyAssigned: false }); }
      catch (error) { throw new Error(apiErrorMessage(error)); }
    }
  };

  return <div className="flex flex-col gap-4 py-4">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="text-sm font-medium text-foreground">{s.membersCount.replace('{n}', String(rows.length))}</span>
        <HelpTip>
          <span className="flex flex-col gap-2">
            <span>{s.sharingWarning}</span>
            <span>{s.credentials}</span>
          </span>
        </HelpTip>
      </span>
      {isAdmin
        ? <Button disabled={busy || directory.isLoading || directory.isError} onClick={() => setPicking(true)}>{s.addMembers}</Button>
        : null}
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{s.sharingSummary}</p>
    {/* The directory is a secondary read: when it fails the member list is still correct and usable, so
        the failure is reported beside the picker instead of replacing the whole tab. */}
    {isAdmin && directory.isError
      ? <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
        {apiErrorMessage(directory.error)}
        <Button variant="ghost" onClick={() => { void directory.refetch(); }}>{t.common.retry}</Button>
      </p>
      : null}

    {rows.length === 0
      ? <p className="text-xs text-muted-foreground">{s.membersEmpty}</p>
      : <ul className="flex flex-col divide-y divide-border">
        {rows.map((member) => {
          const self = member.id === actor?.id;
          const label = labelOf(member);
          return <li key={member.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <Avatar user={member} size={32} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm text-foreground">{label}</span>
                {self ? <Badge tone="accent">{s.you}</Badge> : null}
              </span>
              <span className="truncate text-xs text-muted-foreground">{detailOf(member)}</span>
            </span>
            <Button variant="ghost-danger" disabled={busy} onClick={() => setChange({ userId: member.id, label, currentlyAssigned: true })}>
              {self ? s.leave : s.removeMember}
            </Button>
          </li>;
        })}
      </ul>}

    {canInvite && !isAdmin
      ? <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (validInvite && !busy) setChange({ userId: Number(inviteId), label: s.member.replace('{id}', inviteId), currentlyAssigned: false });
      }}>
        <span className="min-w-[8rem] flex-1">
          <Field label={s.userId} hint={s.userIdHint}>
            <Input type="number" min={1} step={1} value={inviteId} onChange={(event) => setInviteId(event.target.value)} disabled={busy} />
          </Field>
        </span>
        <Button type="submit" disabled={!validInvite || busy}>{s.invite}</Button>
      </form>
      : null}
    {canInvite ? null : <p className="text-xs text-muted-foreground">{s.inviteDenied}</p>}

    <ManageSelectionModal
      title={s.addTitle}
      subtitle={s.addHint}
      open={picking}
      onClose={() => setPicking(false)}
      items={items}
      selected={new Set<string>()}
      onSave={addMembers}
      saving={assign.isPending}
      emptySelectionHint={items.length === 0 ? s.addEmpty : undefined}
      countLabel={(count) => s.addSelected.replace('{n}', String(count))}
    />
    <ConfirmDialog open={change !== null} title={change?.currentlyAssigned ? s.removeMember : s.invite}
      description={`${change?.label ?? ''}: ${change?.currentlyAssigned ? s.revokeWarning : s.sharingWarning}`}
      confirmLabel={change?.currentlyAssigned ? s.removeMember : s.invite} pending={assign.isPending}
      onClose={() => setChange(null)} onConfirm={async () => {
        if (!change) return;
        try { await assign.mutateAsync({ userId: change.userId, projectId: project.id, currentlyAssigned: change.currentlyAssigned }); }
        catch (error) { throw new Error(apiErrorMessage(error)); }
        setChange(null); setInviteId('');
      }} />
  </div>;
}
