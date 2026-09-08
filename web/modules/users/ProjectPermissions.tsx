'use client';
import { useState } from 'react';
import { apiErrorMessage } from '../../lib/elowenClient';
import type { User } from '../../lib/types';
import { useUpdateUser } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';
import { managedProjectStrings } from '../projects/managedProjectStrings';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { Toggle } from '../../components/ui/Toggle';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/Toast';

export function ProjectPermissions({ user }: { user: User }) {
  const { t, locale } = useTranslation();
  const s = managedProjectStrings[locale];
  const update = useUpdateUser();
  const { toast } = useToast();
  const [create, setCreate] = useState(user.can_create_projects === true);
  const [share, setShare] = useState(user.can_share_projects === true);
  const [limit, setLimit] = useState(String(user.project_limit ?? 3));
  const valid = /^\d+$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 1000;
  return <form className="flex flex-col gap-3" onSubmit={(event) => {
    event.preventDefault();
    if (!valid || update.isPending) return;
    update.mutate({ id: user.id, patch: { can_create_projects: create, can_share_projects: share, project_limit: Number(limit) } }, {
      onSuccess: () => toast(t.common.saved), onError: (error) => toast(apiErrorMessage(error), 'error'),
    });
  }}>
    <Field label={s.createGrant}><Toggle label={s.createGrant} checked={create} onChange={setCreate} disabled={update.isPending} /></Field>
    <Field label={s.shareGrant}><Toggle label={s.shareGrant} checked={share} onChange={setShare} disabled={update.isPending} /></Field>
    <Field label={s.limit} hint={s.limitHint}><Input type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(e.target.value)} disabled={update.isPending} /></Field>
    <Button type="submit" disabled={!valid || update.isPending}>{s.savePermissions}</Button>
  </form>;
}
