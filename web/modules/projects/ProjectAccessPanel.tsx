'use client';
import { useState } from 'react';
import { apiErrorMessage } from '../../lib/elowenClient';
import { useMe, useProjectMemberProfiles, useUsers } from '../../lib/queries';
import { useAssignProject } from '../../lib/mutations';
import { plural, useTranslation } from '../../lib/i18n';
import type { Project, ProjectMemberView } from '../../lib/types';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { ErrorState, LoadingLine, LoadingState } from '../../components/ui/states';

/** What to call a member: the display name when the account has one, the handle otherwise. */
const labelOf = (member: ProjectMemberView) => member.name.trim() || member.username;

/** The badges that tell two similar names apart, in the order the account picker uses everywhere else. */
const badgesOf = (member: { username: string; email?: string }) => [
  { text: `@${member.username}`, tone: 'muted' as const },
  ...(member.email ? [{ text: member.email, tone: 'muted' as const }] : []),
];

/** A project's People tab: the access summary, the shared account picker, and nothing else — a project's
 *  membership does not become a different kind of thing when it runs in a container.
 *
 *  Two facts about a MANAGED project are additions to that one panel rather than a second one. Membership
 *  hands over every file and stored credential inside the environment, so the picker carries that warning
 *  and a single invitation asks before it is made. And a member cannot widen the picker, because
 *  `GET /users` is the instance directory and is admin-only: they manage the people already here and add
 *  by account id instead of browsing everyone on the instance. */
export function ProjectAccessPanel({ project }: { project: Project }) {
  const { t } = useTranslation();
  const s = t.projects;
  const me = useMe();
  // The identity view of the membership: this tab is where a member sees WHO shares the project, so it
  // opts into the profile projection rather than the endpoint's default id list.
  const members = useProjectMemberProfiles(project.id);
  const assign = useAssignProject();
  const actor = me.data?.user;
  const isAdmin = actor?.is_admin === true;
  const directory = useUsers(isAdmin);
  const managed = project.executionKind === 'managed';
  const [inviteId, setInviteId] = useState('');
  const [open, setOpen] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);

  if (me.isError || members.isError) {
    return <ErrorState message={apiErrorMessage(me.error ?? members.error)} onRetry={() => { void me.refetch(); void members.refetch(); }} />;
  }
  if (me.isLoading || members.isLoading) return <LoadingState variant="list" />;

  const rows = members.data ?? [];
  const memberIds = new Set(rows.map((member) => member.id));
  // Adding by account id exists for the reader who has no directory to pick from.
  const canInvite = managed && !isAdmin && actor?.can_share_projects === true;
  const busy = assign.isPending || project.lifecycle === 'deleting';
  const validInvite = /^\d+$/.test(inviteId) && Number.isSafeInteger(Number(inviteId)) && Number(inviteId) > 0 && !memberIds.has(Number(inviteId));
  // Administrators reach every project without an assignment row, so the picker offers ordinary accounts;
  // an administrator who is also a member still shows in the summary.
  const assignable = (directory.data ?? []).filter((user) => !user.is_admin);

  // Whoever can see the directory manages membership through it. Whoever cannot sees the people already
  // here, and can still take one out — the same modal, narrowed to what this account may actually know.
  const items: ManageSelectionItem[] = isAdmin
    ? assignable.map((user) => ({
      id: String(user.id),
      label: user.name || user.username,
      badges: badgesOf(user),
      group: 'accounts',
      groupLabel: s.accountsGroup,
      icon: <Avatar user={user} size={18} />,
    }))
    : rows.map((member) => ({
      id: String(member.id),
      label: labelOf(member),
      badges: badgesOf(member),
      group: 'accounts',
      groupLabel: s.accountsGroup,
      icon: <Avatar user={member} size={18} />,
    }));
  const selectable = isAdmin ? assignable.map((user) => user.id) : rows.map((member) => member.id);
  const selected = new Set(selectable.filter((id) => memberIds.has(id)).map(String));

  const save = async (next: Set<string>) => {
    const changes = selectable.filter((id) => next.has(String(id)) !== memberIds.has(id));
    // Sequential: a partial failure stops instead of fanning out further grants, and the refreshed
    // summary then shows exactly which ones landed.
    for (const userId of changes) {
      try { await assign.mutateAsync({ userId, projectId: project.id, currentlyAssigned: memberIds.has(userId) }); }
      catch (error) { throw new Error(apiErrorMessage(error)); }
    }
  };

  return (
    <div className="py-3">
      {/* The directory is what the administrator's summary counts, so the summary waits for it. Rendered
          unconditionally, an empty `assignable` while it is still arriving — or after it failed — would
          say "no member accounts are available", which is the empty state inventing a reason of its own.
          A member reads no directory at all and goes straight to the summary. */}
      {!isAdmin || directory.isSuccess ? (
        isAdmin && assignable.length === 0 ? <p className="text-xs text-muted-foreground">{t.projects.accessEmpty}</p> : (
          <SelectionSummary
            // The administrator's wording counts members WITHIN the directory they can see, so an
            // administrator who reaches the project without an assignment row is not counted against a
            // total they are not part of. A member sees no directory, so there is no total to state.
            countText={isAdmin
              ? t.projects.accessCount.replace('{n}', String(assignable.filter((user) => memberIds.has(user.id)).length)).replace('{total}', String(assignable.length))
              : plural(s.accessCountMembers, rows.length).replace('{n}', String(rows.length))}
            samples={rows.slice(0, 3).map((member) => ({ id: String(member.id), label: labelOf(member), icon: <Avatar user={member} size={16} /> }))}
            moreCount={Math.max(0, rows.length - 3)}
            onManage={() => setOpen(true)}
            manageLabel={t.managePicker.manage}
          />
        )
      ) : directory.isLoading ? <LoadingLine /> : null}
      {/* A directory that failed is not an empty one, so no count is stated at all: the only figure left
          would be a zero the reader would take for the truth. The failure is said in the summary's place,
          with the retry that fixes it, rather than replacing the whole tab. */}
      {isAdmin && directory.isError ? (
        <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive">
          {apiErrorMessage(directory.error)}
          <Button variant="ghost" onClick={() => { void directory.refetch(); }}>{t.common.retry}</Button>
        </p>
      ) : null}

      {canInvite ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(event) => { event.preventDefault(); if (validInvite && !busy) setInviting(inviteId); }}
        >
          <span className="min-w-[8rem] flex-1">
            <Field label={s.userId} hint={s.userIdHint}>
              <Input type="number" min={1} step={1} value={inviteId} onChange={(event) => setInviteId(event.target.value)} disabled={busy} />
            </Field>
          </span>
          <Button type="submit" disabled={!validInvite || busy}>{s.invite}</Button>
        </form>
      ) : null}
      {managed && !isAdmin && !canInvite ? <p className="mt-2 text-xs text-muted-foreground">{s.inviteDenied}</p> : null}

      <ManageSelectionModal
        title={t.projects.accessTitle}
        // A managed project's membership is stated in terms of what it hands over; a host project's in
        // terms of who may use it.
        subtitle={managed ? s.sharingWarning : t.projects.accessHint}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={selected}
        onSave={save}
        saving={assign.isPending}
        countLabel={(count) => plural(t.projects.accessSelected, count).replace('{n}', String(count))}
      />
      <ConfirmDialog
        open={inviting !== null}
        title={s.invite}
        description={`${s.member.replace('{id}', inviting ?? '')}: ${s.sharingWarning}`}
        confirmLabel={s.invite}
        pending={assign.isPending}
        onClose={() => setInviting(null)}
        onConfirm={async () => {
          if (!inviting) return;
          try { await assign.mutateAsync({ userId: Number(inviting), projectId: project.id, currentlyAssigned: false }); }
          catch (error) { throw new Error(apiErrorMessage(error)); }
          setInviting(null); setInviteId('');
        }}
      />
    </div>
  );
}
