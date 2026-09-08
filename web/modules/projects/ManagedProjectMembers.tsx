'use client';
import { useState } from 'react';
import { apiErrorMessage } from '../../lib/elowenClient';
import { useMe, useProjectUsers } from '../../lib/queries';
import { useAssignProject } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';
import type { Project } from '../../lib/types';
import { managedProjectStrings } from './managedProjectStrings';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ErrorState, LoadingState } from '../../components/ui/states';

export function ManagedProjectMembers({ project }: { project: Project }) {
  const { locale } = useTranslation();
  const s = managedProjectStrings[locale];
  const me = useMe();
  const members = useProjectUsers(project.id);
  const assign = useAssignProject();
  const [inviteId, setInviteId] = useState('');
  const [change, setChange] = useState<{ userId: number; currentlyAssigned: boolean } | null>(null);
  const actor = me.data?.user;
  const canInvite = actor?.is_admin || actor?.can_share_projects;
  const busy = assign.isPending || project.lifecycle === 'deleting';
  const validInvite = /^\d+$/.test(inviteId) && Number.isSafeInteger(Number(inviteId)) && Number(inviteId) > 0 && !members.data?.includes(Number(inviteId));
  if (me.isError || members.isError) return <ErrorState message={apiErrorMessage(me.error ?? members.error)} onRetry={() => { void me.refetch(); void members.refetch(); }} />;
  if (me.isLoading || members.isLoading) return <LoadingState variant="list" />;
  return <div className="flex flex-col gap-4 py-4">
    <p className="text-xs leading-relaxed text-muted-foreground">{s.sharingWarning}</p>
    <p className="text-xs leading-relaxed text-muted-foreground">{s.credentials}</p>
    <ul className="divide-y divide-border">
      {(members.data ?? []).map((id) => <li key={id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span className="text-sm">{id === actor?.id ? `${actor.name || actor.username} · ` : ''}{s.member.replace('{id}', String(id))}</span>
        <Button variant="ghost-danger" disabled={busy} onClick={() => setChange({ userId: id, currentlyAssigned: true })}>{id === actor?.id ? s.leave : s.removeMember}</Button>
      </li>)}
    </ul>
    {canInvite ? <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); if (validInvite && !busy) setChange({ userId: Number(inviteId), currentlyAssigned: false }); }}>
      <Field label={s.userId} hint={s.userIdHint}><Input type="number" min={1} step={1} value={inviteId} onChange={(event) => setInviteId(event.target.value)} disabled={busy} /></Field>
      <Button type="submit" disabled={!validInvite || busy}>{s.invite}</Button>
    </form> : <p className="text-xs text-muted-foreground">{s.inviteDenied}</p>}
    <ConfirmDialog open={change !== null} title={change?.currentlyAssigned ? s.removeMember : s.invite}
      description={`${s.member.replace('{id}', String(change?.userId ?? ''))}: ${change?.currentlyAssigned ? s.revokeWarning : s.sharingWarning}`}
      confirmLabel={change?.currentlyAssigned ? s.removeMember : s.invite} pending={assign.isPending}
      onClose={() => setChange(null)} onConfirm={async () => {
        if (!change) return;
        try { await assign.mutateAsync({ ...change, projectId: project.id }); }
        catch (error) { throw new Error(apiErrorMessage(error)); }
        setChange(null); setInviteId('');
      }} />
  </div>;
}
