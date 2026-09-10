import type { BrainDeps } from '../brainDeps.js';
import type { SpawnOpts } from '../session/liveBrain.js';
import type { ProjectExecutionRef } from '../../shared/projectExecution.js';

/** Select metadata only. Provisioning belongs to the first environment operation, not chat creation. */
export function preparePersonalProject(
  deps: Pick<BrainDeps, 'store' | 'projects' | 'policy'>,
  opts: SpawnOpts,
): { policy: SpawnOpts['policy']; projectRef?: ProjectExecutionRef; initialRef?: ProjectExecutionRef } {
  if (deps.store.getSession(opts.sessionId)) {
    return { policy: opts.policy, projectRef: deps.store.getProjectExecution(opts.sessionId) };
  }
  if (opts.parentSessionId || opts.delegatedAccess || opts.fork || opts.pathView
    || opts.scheduled || (opts.channel && !opts.direct) || opts.clientCwd) {
    return { policy: opts.policy, projectRef: opts.delegatedAccess?.projectRef };
  }
  // BrainDeps also supports embedded brains without a project catalog. Only the project-enabled daemon
  // can select a managed default; an existing managed ref above never falls back through this seam.
  if (!deps.projects) return { policy: opts.policy };
  if (!deps.policy) throw new Error('personal project metadata unavailable');
  // An administrator's conversation with no project chosen is the host, unrestricted, exactly as it was
  // before project environments existed. Binding them to a private managed project instead took away the
  // files, the shell and the tools they had, and nothing in the conversation said why.
  if (opts.policy.allowedProjectIds === 'all') return { policy: opts.policy };
  // Everyone else opens in a project they are already assigned to, within the ceiling this spawn was
  // given. The lowest id is the deterministic choice — the same project every time this account opens a
  // conversation — and only an account with no assignment at all falls through to the private default.
  const live = deps.policy(opts.ownerUserId);
  const assigned = [...opts.policy.allowedProjectIds].sort((a, b) => a - b)
    .filter((id) => live.canAccessProject?.(id) === true)
    .map((id) => deps.projects!.get(id))
    .find((candidate) => candidate?.lifecycle === 'active');
  if (assigned) {
    const ref: ProjectExecutionRef = assigned.executionKind === 'managed'
      ? { kind: 'managed', projectId: assigned.id }
      : { kind: 'host', projectId: assigned.id };
    return { policy: opts.policy, projectRef: ref, initialRef: ref };
  }
  const project = deps.projects.ensureDefault(opts.ownerUserId);
  // Default creation adds a membership. A policy captured before it has an obsolete project ceiling.
  const fresh = deps.policy(opts.ownerUserId);
  if (!fresh.canAccessProject?.(project.id)) throw new Error('personal project access denied');
  // An all-access caller returned above, so the ceiling here is always an explicit set.
  const allowedProjectIds = new Set([...opts.policy.allowedProjectIds, project.id].filter((id) => fresh.canAccessProject?.(id)));
  const policy = {
    ...opts.policy,
    allowedProjectIds,
    canAccessProject: (id: number) => allowedProjectIds.has(id) && fresh.canAccessProject?.(id) === true,
  };
  const projectRef: ProjectExecutionRef = { kind: 'managed', projectId: project.id };
  return { policy, projectRef, initialRef: projectRef };
}
