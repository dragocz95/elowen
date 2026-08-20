import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, KeyRound, MessageCircle, RefreshCw, Search, Settings2, ShieldCheck, UserCheck, Users } from 'lucide-react';
import { apiJson, runtime, type ConfigField, type PeopleResponse, type PluginDetail, type RolePolicy, type TeamsAccountDetail, type TeamsIdentity, type TeamsPerson, type User } from './runtime';

type WorkspaceTab = 'people' | 'settings';
type PersonFilter = 'all' | 'mapped' | 'unmapped';

export function matchesPerson(policy: RolePolicy, person: TeamsPerson): boolean {
  const roleId = policy.roleId.trim();
  if (roleId === '' || roleId === '*') return false;
  if (person.upn && roleId.includes('@') && roleId.toLowerCase() === person.upn.toLowerCase()) return true;
  return [person.aadObjectId, person.teamsId].some((id) => id !== '' && roleId === id);
}

function isBroadPolicy(policy: RolePolicy): boolean {
  const roleId = policy.roleId.trim();
  return roleId === '*' || roleId.startsWith('a:') || roleId.startsWith('19:');
}

/** Conversation and wildcard policies win over every matching person policy below them, exactly as the
 * adapter's first-match lookup does. */
export function directPolicyIndex(policies: RolePolicy[], person: TeamsPerson): number {
  const direct = policies.findIndex((policy) => matchesPerson(policy, person));
  if (direct < 0) return -1;
  const broad = policies.findIndex(isBroadPolicy);
  return broad < 0 || direct < broad ? direct : -1;
}

export function effectivePersonPolicy(policies: RolePolicy[], person: TeamsPerson): RolePolicy | undefined {
  return policies.find((policy) => policy.roleId.trim() === '*' || matchesPerson(policy, person));
}

/** Insert or relocate one person's policy before every conversation/wildcard fallback. */
export function upsertDirectPolicy(policies: RolePolicy[], person: TeamsPerson, nextPolicy: RolePolicy): RolePolicy[] {
  const existing = policies.find((policy) => matchesPerson(policy, person));
  const next = policies.filter((policy) => !matchesPerson(policy, person));
  const broad = next.findIndex(isBroadPolicy);
  next.splice(broad < 0 ? next.length : broad, 0, existing ?? nextPolicy);
  return next;
}

function primaryId(person: TeamsPerson): string {
  return person.aadObjectId || person.upn || person.teamsId || person.key;
}

function policiesOf(values: Record<string, unknown>): RolePolicy[] {
  return Array.isArray(values.rolePolicies) ? values.rolePolicies as RolePolicy[] : [];
}

/** Person access owns rolePolicies. The global settings tab keeps the same draft but must not expose a
 * second editor for the same ordered authorization list. Existing fallback policies stay persisted. */
export function globalSettingsDetail(detail: PluginDetail): PluginDetail {
  return {
    ...detail,
    configSchema: detail.configSchema.filter((field) => field.key !== 'sec_roles' && field.key !== 'rolePolicies'),
  };
}

export function linkedUserFor(person: TeamsPerson, users: User[]): User | undefined {
  const identityUser = person.identity?.user;
  if (!identityUser) return undefined;
  return users.find((user) => user.id === identityUser.id || user.username.toLowerCase() === identityUser.username.toLowerCase());
}

function linkedPolicyUserFor(policies: RolePolicy[], person: TeamsPerson, users: User[]): User | undefined {
  const index = directPolicyIndex(policies, person);
  const ref = index >= 0 ? String(policies[index]?.elowenUser ?? '').trim() : '';
  return ref ? users.find((user) => user.username.toLowerCase() === ref.toLowerCase() || String(user.id) === ref) : undefined;
}

export function shouldShowLegacyAccountSelector(accountLinking: boolean): boolean {
  return !accountLinking;
}

export function accountDetailPath(aadObjectId: string): string {
  return `/plugins/msteams/people/${encodeURIComponent(aadObjectId)}/account`;
}

export function accountIdentityFromDetail(detail: TeamsAccountDetail): TeamsIdentity {
  return {
    linked: detail.linked,
    ...(detail.user ? { user: { id: detail.user.id, username: detail.user.username, isAdmin: detail.user.isAdmin } } : {}),
    ...(detail.linkedAt ? { linkedAt: detail.linkedAt } : {}),
  };
}

export function bindAccountRequest(userId: number, replace = false): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, ...(replace ? { replace: true } : {}) }),
  };
}

export function peopleWithAccountDetail(response: PeopleResponse, aadObjectId: string, detail: TeamsAccountDetail): PeopleResponse {
  return {
    ...response,
    people: response.people.map((person) => person.aadObjectId === aadObjectId
      ? { ...person, identity: accountIdentityFromDetail(detail) }
      : person),
  };
}

/**
 * SelectMenu resolves a value that matches no option to the first one, so an identity with no linked
 * account would render as if the first account in the list were already linked. The unlinked state
 * therefore needs an option of its own; once an account is linked the field only offers replacements.
 */
export function accountLinkOptions(linkedUserId: number | undefined, users: User[], noneLabel: string): { value: string; label: string; user?: User }[] {
  return [
    ...(linkedUserId === undefined ? [{ value: '', label: noneLabel }] : []),
    ...users.map((user) => ({
      value: String(user.id),
      label: user.name ? `${user.name} · @${user.username}` : `@${user.username}`,
      user,
    })),
  ];
}

function legacyAccountOptions(policy: RolePolicy | null, users: User[], noneLabel: string): { value: string; label: string; user?: User }[] {
  const ref = String(policy?.elowenUser ?? '').trim();
  const selected = ref ? users.find((user) => user.username.toLowerCase() === ref.toLowerCase() || String(user.id) === ref) : undefined;
  return [
    { value: '', label: noneLabel },
    ...(ref && !selected ? [{ value: ref, label: ref }] : []),
    ...users.map((user) => ({
      value: selected?.id === user.id ? ref : user.username,
      label: user.name ? `${user.name} · @${user.username}` : `@${user.username}`,
      user,
    })),
  ];
}

function formatTimestamp(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function IdentityCard({ person, users, onDetail }: {
  person: TeamsPerson;
  users: User[];
  onDetail(aadObjectId: string, detail: TeamsAccountDetail): void;
}) {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings('msteams');
  const [detail, setDetail] = useState<TeamsAccountDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacement, setReplacement] = useState<User | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    setReplacement(null);
    if (!person.aadObjectId) {
      setLoading(false);
      return () => { live = false; };
    }
    setLoading(true);
    void apiJson<TeamsAccountDetail>(accountDetailPath(person.aadObjectId))
      .then((value) => {
        if (!live) return;
        setDetail(value);
        onDetail(person.aadObjectId, value);
      })
      .catch((reason) => { if (live) setError(utils.apiErrorMessage(reason)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [onDetail, person.aadObjectId, utils]);

  const applyDetail = (value: TeamsAccountDetail) => {
    setDetail(value);
    setError(null);
    onDetail(person.aadObjectId, value);
  };
  const bind = async (user: User, replace: boolean) => {
    setPending(true);
    setError(null);
    try {
      applyDetail(await apiJson<TeamsAccountDetail>(accountDetailPath(person.aadObjectId), bindAccountRequest(user.id, replace)));
      setReplacement(null);
    } catch (reason) {
      setError(utils.apiErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };
  const signOut = async () => {
    setPending(true);
    setError(null);
    try {
      applyDetail(await apiJson<TeamsAccountDetail>(`${accountDetailPath(person.aadObjectId).replace(/\/account$/, '')}/signout`, { method: 'POST' }));
    } catch (reason) {
      setError(utils.apiErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  const identity = detail ?? { linked: person.identity?.linked === true, user: person.identity?.user, linkedAt: person.identity?.linkedAt, signedIn: false };
  const linkedHostUser = identity.user
    ? users.find((user) => user.id === identity.user?.id || user.username.toLowerCase() === identity.user?.username.toLowerCase())
    : undefined;
  const accountOptions = accountLinkOptions(identity.user?.id, users, s.accountNone).map((option) => ({
    value: option.value,
    label: option.label,
    icon: option.user
      ? <C.Avatar name={option.user.name || option.user.username} user={option.user} size="sm" />
      : <UserCheck size={15} />,
  }));
  const statusLabel = identity.linked ? (identity.signedIn ? s.identityConnected : s.identityNeedsSignIn) : s.identityNotLinked;
  const profile = detail?.profile;

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{s.identityTitle}</p>
          <div className="mt-2 flex items-center gap-2">
            <C.Badge tone={identity.signedIn ? 'success' : identity.linked ? 'warning' : undefined}>{statusLabel}</C.Badge>
            {loading ? <span className="text-xs text-text-muted">{s.identityLoading}</span> : null}
          </div>
        </div>
        <C.Button variant="ghost" icon={RefreshCw} disabled={pending || !person.aadObjectId} onClick={() => void signOut()}>
          {s.identityForceSignIn}
        </C.Button>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-text">{s.identityMicrosoftProfile}</p>
          <p className="text-sm text-text">{profile?.displayName || person.name || s.personFallback}</p>
          <p className="break-all text-xs text-text-muted">{profile?.userPrincipalName || person.upn || '—'}</p>
          {profile?.mail && profile.mail !== profile.userPrincipalName ? <p className="break-all text-xs text-text-muted">{profile.mail}</p> : null}
          <p className="break-all font-mono text-[11px] text-text-subtle">{profile?.id || person.aadObjectId || '—'}</p>
          {profile ? <p className="text-xs text-text-muted">{profile.userType} · {profile.accountEnabled ? s.identityAccountEnabled : s.identityAccountDisabled}</p> : null}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-text">{s.identityElowenAccount}</p>
          {identity.user ? (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-elevated/40 p-3">
              <C.Avatar name={linkedHostUser?.name || identity.user.username} user={linkedHostUser} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">{linkedHostUser?.name || `@${identity.user.username}`}</p>
                <p className="truncate text-xs text-text-muted">@{identity.user.username}</p>
              </div>
              {identity.user.isAdmin ? <C.Badge tone="accent">{s.identityAdmin}</C.Badge> : null}
            </div>
          ) : <p className="text-xs text-text-muted">{s.identityNoElowenAccount}</p>}
          <C.Field label={identity.user ? s.identityChangeAccount : s.identityLinkAccount} hint={s.identityLinkAccountHint}>
            <C.SelectMenu
              value={identity.user ? String(identity.user.id) : ''}
              onChange={(value: string) => {
                const user = users.find((candidate) => String(candidate.id) === value);
                if (!user || user.id === identity.user?.id) return;
                if (identity.linked) setReplacement(user);
                else void bind(user, false);
              }}
              options={accountOptions}
              label={identity.user ? s.identityChangeAccount : s.identityLinkAccount}
              disabled={pending}
            />
          </C.Field>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-3 text-xs text-text-muted">
        <span>{person.hasPersonalChat ? s.identityPersonalChatOpen : s.identityPersonalChatMissing}</span>
        <span>{s.identityLastSeen.replace('{value}', formatTimestamp(person.lastSeenAt))}</span>
        <span>{identity.signedIn ? s.identitySessionActive : s.identitySessionSignedOut}</span>
        {identity.linkedAt ? <span>{s.identityLinkedAt.replace('{value}', formatTimestamp(identity.linkedAt))}</span> : null}
        {detail?.verifiedAt ? <span>{s.identityVerifiedAt.replace('{value}', formatTimestamp(detail.verifiedAt))}</span> : null}
      </div>
      {pending ? <p className="mt-3 text-xs text-text-muted" aria-live="polite">{s.identitySaving}</p> : null}
      {error ? <p className="mt-3 text-xs text-danger" role="alert">{error}</p> : null}

      <C.ConfirmDialog
        open={replacement !== null}
        title={s.identityReplaceTitle}
        description={replacement ? s.identityReplaceDescription.replace('{username}', replacement.username) : ''}
        confirmLabel={s.identityReplaceConfirm}
        onConfirm={() => { if (replacement) void bind(replacement, true); }}
        onClose={() => setReplacement(null)}
      />
    </section>
  );
}

function PeopleAccess({ draft, response, onIdentityDetail }: {
  draft: ReturnType<ReturnType<typeof runtime>['hooks']['usePluginConfigDraft']>;
  response: PeopleResponse;
  onIdentityDetail(aadObjectId: string, detail: TeamsAccountDetail): void;
}) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('msteams');
  const users = hooks.useUsers().data ?? [];
  const projects = hooks.useProjects().data ?? [];
  const plugins = hooks.usePlugins().data ?? [];
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PersonFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(response.people[0]?.key ?? null);
  const [toolsOpen, setToolsOpen] = useState(false);

  const policies = policiesOf(draft.values);
  const visible = response.people.filter((person) => {
    const mapped = directPolicyIndex(policies, person) >= 0;
    if (filter === 'mapped' && !mapped) return false;
    if (filter === 'unmapped' && mapped) return false;
    const haystack = `${person.name} ${person.upn} ${person.aadObjectId}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });
  const selected = response.people.find((person) => person.key === selectedKey) ?? visible[0] ?? null;
  const policyIndex = selected === null ? -1 : directPolicyIndex(policies, selected);
  const policy = policyIndex >= 0 ? policies[policyIndex]! : null;
  const accountLinking = draft.values.accountLinking === true;
  const selectedUser = selected === null
    ? undefined
    : accountLinking ? linkedUserFor(selected, users) : linkedPolicyUserFor(policies, selected, users);

  const replacePolicies = (next: RolePolicy[]) => draft.setValue('rolePolicies', next);
  const createPolicy = () => {
    if (selected === null) return;
    const nextPolicy = { roleId: primaryId(selected), name: selected.name || selected.upn || s.personFallback, projectIds: [], prompt: '', tools: [] };
    replacePolicies(upsertDirectPolicy(policies, selected, nextPolicy));
  };
  const patchPolicy = (patch: Partial<RolePolicy>) => {
    if (policyIndex < 0) return;
    replacePolicies(policies.map((item, index) => index === policyIndex ? { ...item, ...patch } : item));
  };
  const removePolicy = () => {
    if (policyIndex < 0) return;
    replacePolicies(policies.filter((_, index) => index !== policyIndex));
  };

  const owners = new Map<string, string>();
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    for (const tool of plugin.provides.tools ?? []) if (!owners.has(tool)) owners.set(tool, plugin.name);
  }
  const selectedTools = policy?.tools ?? [];
  const knownTools = new Set(owners.keys());
  const toolItems = [
    ...selectedTools.filter((tool) => !knownTools.has(tool)).map((tool) => ({ id: tool, label: tool, group: s.unavailableTools })),
    ...[...owners.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tool, plugin]) => ({ id: tool, label: tool, group: plugin })),
  ];
  const legacyOptions = legacyAccountOptions(policy, users, s.accountNone).map((option) => ({
    value: option.value,
    label: option.label,
    icon: option.user
      ? <C.Avatar name={option.user.name || option.user.username} user={option.user} size="sm" />
      : <UserCheck size={15} />,
  }));
  const inherited = policies.some((item) => item.roleId === '*');

  return (
    <C.ControlSurfaceDocument>
      <C.ControlSurfaceToolbar>
        <div className="flex w-full flex-wrap items-center gap-3">
          <div className="relative min-w-[15rem] flex-1">
            <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <C.Input value={search} onChange={(event: { target: { value: string } }) => setSearch(event.target.value)} placeholder={s.peopleSearch} className="pl-9" />
          </div>
          <div className="flex rounded-lg border border-border bg-surface p-1">
            {(['all', 'mapped', 'unmapped'] as const).map((value) => (
              <button
                type="button"
                key={value}
                onClick={() => setFilter(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${filter === value ? 'bg-accent text-accent-foreground' : 'text-text-muted hover:text-text'}`}
              >
                {value === 'all' ? s.filterAll : value === 'mapped' ? s.filterMapped : s.filterUnmapped}
              </button>
            ))}
          </div>
        </div>
      </C.ControlSurfaceToolbar>

      {response.people.length === 0 ? (
        <C.ControlSurfaceState>
          <C.EmptyState title={s.peopleEmptyTitle} description={s.peopleEmptyDescription} icon={Users} />
        </C.ControlSurfaceState>
      ) : visible.length === 0 ? (
        <C.ControlSurfaceState>
          <C.EmptyState title={s.peopleNoResults} description={s.peopleNoResultsDescription} icon={Search} />
        </C.ControlSurfaceState>
      ) : (
        <C.ControlSurfaceRegister className="grid min-h-[31rem] grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(24rem,1.2fr)]">
          <div className="flex min-w-0 flex-col gap-2">
            {visible.map((person) => {
              const mapped = directPolicyIndex(policies, person) >= 0;
              const linkedUser = accountLinking ? linkedUserFor(person, users) : linkedPolicyUserFor(policies, person, users);
              const active = selected?.key === person.key;
              return (
                <button
                  type="button"
                  key={person.key}
                  onClick={() => setSelectedKey(person.key)}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${active ? 'border-accent/60 bg-accent/10' : 'border-border bg-surface hover:border-border-strong hover:bg-elevated/50'}`}
                >
                  <C.Avatar name={person.name || person.upn || s.personFallback} src={person.teamsAvatarUrl} user={linkedUser} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-text">{person.name || s.personFallback}</span>
                    <span className="block truncate text-xs text-text-muted">{person.upn || person.aadObjectId}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <C.Badge tone={mapped ? 'accent' : undefined}>{mapped ? s.badgeMapped : inherited ? s.badgeInherited : s.badgeUnmapped}</C.Badge>
                    {person.hasPersonalChat ? <span className="inline-flex items-center gap-1 text-[11px] text-text-muted"><MessageCircle size={11} aria-hidden />{s.chatOpen}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="min-w-0 rounded-xl border border-border bg-elevated/30 p-5">
            {selected === null ? null : (
              <div className="flex flex-col gap-5">
                <div className="flex items-start gap-3">
                  <C.Avatar name={selected.name || selected.upn || s.personFallback} src={selected.teamsAvatarUrl} user={selectedUser} size="lg" />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold text-text">{selected.name || s.personFallback}</h2>
                    <p className="truncate text-sm text-text-muted">{selected.upn || selected.aadObjectId}</p>
                    <p className="mt-1 font-mono text-[11px] text-text-subtle">{selected.aadObjectId || selected.teamsId}</p>
                  </div>
                  {policy ? <C.Button variant="ghost" onClick={removePolicy}>{s.removeAccess}</C.Button> : null}
                </div>

                {accountLinking ? <IdentityCard key={selected.key} person={selected} users={users} onDetail={onIdentityDetail} /> : null}

                {policy === null ? (
                  <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 text-center">
                    <UserCheck size={28} className="text-text-muted" aria-hidden />
                    <div>
                      <p className="text-sm font-semibold text-text">{inherited ? s.inheritedTitle : s.unmappedTitle}</p>
                      <p className="mt-1 max-w-md text-xs leading-relaxed text-text-muted">{inherited ? s.inheritedDescription : s.unmappedDescription}</p>
                    </div>
                    <C.Button variant="accent" icon={KeyRound} onClick={createPolicy}>{s.configureAccess}</C.Button>
                  </div>
                ) : (
                  <>
                    {shouldShowLegacyAccountSelector(accountLinking) ? (
                      <C.Field label={s.accountLabel} hint={s.accountHint}>
                        <C.SelectMenu
                          value={policy.elowenUser ?? ''}
                          onChange={(value: string) => patchPolicy({ elowenUser: value || undefined })}
                          options={legacyOptions}
                          label={s.accountLabel}
                        />
                      </C.Field>
                    ) : null}

                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-3">
                      <C.Toggle checked={policy.admin === true} onChange={(value: boolean) => patchPolicy({ admin: value })} label={s.adminLabel} />
                      <span>
                        <span className="block text-sm font-medium text-text">{s.adminLabel}</span>
                        <span className="block text-xs leading-relaxed text-text-muted">{s.adminHint}</span>
                      </span>
                    </label>

                    <C.Field label={s.projectsLabel} hint={s.projectsHint}>
                      <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-border bg-surface p-3">
                        {projects.map((project) => {
                          const checked = policy.projectIds.includes(project.id);
                          return (
                            <label key={project.id} className="flex cursor-pointer items-center gap-2 text-sm text-text">
                              <span onClick={() => patchPolicy({ projectIds: checked ? policy.projectIds.filter((id) => id !== project.id) : [...policy.projectIds, project.id] })}>
                                <C.Checkbox checked={checked} />
                              </span>
                              {project.name || project.slug}
                            </label>
                          );
                        })}
                        {projects.length === 0 ? <span className="text-xs text-text-muted">{s.projectsEmpty}</span> : null}
                      </div>
                    </C.Field>

                    <C.Field label={s.toolsLabel} hint={s.toolsHint}>
                      <C.SelectionSummary
                        countText={selectedTools.length === 0 ? s.toolsAll : s.toolsCount.replace('{n}', String(selectedTools.length))}
                        samples={selectedTools.slice(0, 3).map((tool) => ({ label: tool }))}
                        moreCount={Math.max(0, selectedTools.length - 3)}
                        onManage={() => setToolsOpen(true)}
                        manageLabel={s.manageTools}
                      />
                    </C.Field>
                    <C.ManageSelectionModal
                      title={s.toolsLabel}
                      open={toolsOpen}
                      onClose={() => setToolsOpen(false)}
                      items={toolItems}
                      selected={new Set(selectedTools)}
                      onSave={(next: Set<string>) => patchPolicy({ tools: [...next] })}
                      emptySelectionHint={s.toolsAll}
                      countLabel={(count: number) => s.toolsCount.replace('{n}', String(count))}
                    />

                    <C.Field label={s.promptLabel} hint={s.promptHint}>
                      <textarea
                        value={policy.prompt ?? ''}
                        onChange={(event) => patchPolicy({ prompt: event.target.value })}
                        rows={5}
                        className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none transition focus:border-accent"
                        placeholder={s.promptPlaceholder}
                      />
                    </C.Field>
                  </>
                )}
              </div>
            )}
          </div>
        </C.ControlSurfaceRegister>
      )}
    </C.ControlSurfaceDocument>
  );
}

function LoadedWorkspace({ detail }: { detail: PluginDetail }) {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings('msteams');
  const { locale } = hooks.useTranslation();
  const draft = hooks.usePluginConfigDraft('msteams', detail);
  const [tab, setTab] = useState<WorkspaceTab>('people');
  const [people, setPeople] = useState<PeopleResponse | null>(null);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const updateIdentityDetail = useCallback((aadObjectId: string, account: TeamsAccountDetail) => {
    setPeople((current) => current ? peopleWithAccountDetail(current, aadObjectId, account) : current);
  }, []);

  useEffect(() => {
    let live = true;
    void apiJson<PeopleResponse>('/plugins/msteams/people')
      .then((value) => { if (live) setPeople(value); })
      .catch((error) => { if (live) setPeopleError(utils.apiErrorMessage(error)); });
    return () => { live = false; };
  }, [utils]);

  const policies = policiesOf(draft.values);
  const mappedCount = people?.people.filter((person) => directPolicyIndex(policies, person) >= 0).length ?? 0;
  const openChats = people?.people.filter((person) => person.hasPersonalChat).length ?? 0;
  const adminCount = people === null ? '—' : people.people.filter((person) => effectivePersonPolicy(policies, person)?.admin === true).length;
  const configured = Boolean(String(draft.values.appId ?? '').trim() && String(draft.values.tenantId ?? '').trim() && detail.secretsSet.includes('appPassword'));
  const overlay = detail.i18n?.[locale]?.fields ?? {};
  const fieldLabel = (field: ConfigField) => overlay[field.key]?.label ?? field.label;
  const fieldHint = (field: ConfigField) => overlay[field.key]?.hint ?? field.hint;
  const fieldOptions = (field: ConfigField) => (field.options ?? []).map((option) => ({ value: option.value, label: overlay[field.key]?.options?.[option.value] ?? option.label }));
  const riskText = (risk: 'low' | 'medium' | 'high') => risk === 'high' ? s.riskHigh : risk === 'medium' ? s.riskMedium : s.riskLow;

  const hero = {
    eyebrow: s.workspaceEyebrow,
    title: s.title,
    description: s.workspaceIntro,
    mascotState: peopleError !== null || !configured ? 'error' : draft.status === 'saving' ? 'saving' : 'idle',
    status: (
      <span className="flex items-center gap-3">
        <span className="workspace-status">{configured && people?.active ? s.workspaceReady : s.workspaceSetup}</span>
        <C.AutoSaveStatus status={draft.status} onRetry={draft.retry} />
      </span>
    ),
    action: (
      <C.Button variant="accent" icon={Download} disabled={!configured} onClick={() => { window.location.href = '/api/plugins/msteams/app-package'; }}>
        {s.downloadPackage}
      </C.Button>
    ),
    metrics: (
      <>
        <C.WorkspaceMetric label={s.metricPeople} value={people?.people.length ?? '—'} icon={Users} />
        <C.WorkspaceMetric label={s.metricMapped} value={people === null ? '—' : mappedCount} icon={UserCheck} />
        <C.WorkspaceMetric label={s.metricChats} value={people === null ? '—' : openChats} icon={MessageCircle} />
        <C.WorkspaceMetric label={s.metricAdmins} value={adminCount} icon={ShieldCheck} />
      </>
    ),
  };

  return (
    <C.SpatialWorkspaceLayout
      hero={hero}
      navigation={{
        sections: [
          { id: 'people', label: s.peopleTab, icon: Users },
          { id: 'settings', label: s.settingsTab, icon: Settings2 },
        ],
        value: tab,
        onChange: (value: WorkspaceTab) => setTab(value),
        ariaLabel: s.title,
      }}
    >
      {tab === 'people' ? (
        peopleError !== null ? (
          <C.ControlSurfaceDocument><C.ControlSurfaceState tone="danger"><C.ErrorState message={`${s.peopleLoadError} — ${peopleError}`} /></C.ControlSurfaceState></C.ControlSurfaceDocument>
        ) : people === null ? (
          <C.ControlSurfaceDocument><C.ControlSurfaceState><C.LoadingState variant="list" /></C.ControlSurfaceState></C.ControlSurfaceDocument>
        ) : <PeopleAccess draft={draft} response={people} onIdentityDetail={updateIdentityDetail} />
      ) : (
        <C.SettingsDocument>
          <C.PluginConfigEditor
            name="msteams"
            detail={globalSettingsDetail(detail)}
            draft={draft}
            mode="all"
            showAppPackage={false}
            fieldLabel={fieldLabel}
            fieldHint={fieldHint}
            fieldOptions={fieldOptions}
            riskText={riskText}
          />
        </C.SettingsDocument>
      )}
    </C.SpatialWorkspaceLayout>
  );
}

export function TeamsWorkspace() {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('msteams');
  const detail = hooks.usePluginDetail('msteams');
  const hero = useMemo(() => ({ eyebrow: s.workspaceEyebrow, title: s.title, description: s.workspaceIntro }), [s]);
  if (detail.isError) {
    return <C.SpatialWorkspaceLayout hero={hero}><C.ControlSurfaceDocument><C.ControlSurfaceState tone="danger"><C.ErrorState message={s.settingsLoadError} onRetry={() => detail.refetch()} /></C.ControlSurfaceState></C.ControlSurfaceDocument></C.SpatialWorkspaceLayout>;
  }
  if (detail.isLoading || detail.data === undefined) {
    return <C.SpatialWorkspaceLayout hero={hero}><C.ControlSurfaceDocument><C.ControlSurfaceState><C.LoadingState variant="cards" /></C.ControlSurfaceState></C.ControlSurfaceDocument></C.SpatialWorkspaceLayout>;
  }
  return <LoadedWorkspace detail={detail.data} />;
}
