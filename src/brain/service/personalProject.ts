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
  const project = deps.projects.ensureDefault(opts.ownerUserId);
  // Default creation adds a membership. A policy captured before it has an obsolete project ceiling.
  const fresh = deps.policy(opts.ownerUserId);
  if (!fresh.canAccessProject?.(project.id)) throw new Error('personal project access denied');
  const allowedProjectIds = opts.policy.allowedProjectIds === 'all' ? fresh.allowedProjectIds
    : new Set([...opts.policy.allowedProjectIds, project.id].filter((id) => fresh.canAccessProject?.(id)));
  const policy = {
    ...opts.policy,
    allowedProjectIds,
    canAccessProject: (id: number) => (allowedProjectIds === 'all' || allowedProjectIds.has(id))
      && fresh.canAccessProject?.(id) === true,
  };
  const projectRef: ProjectExecutionRef = { kind: 'managed', projectId: project.id };
  return { policy, projectRef, initialRef: projectRef };
}
