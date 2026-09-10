import { z } from 'zod';
import type { ProjectExecutionRef } from './wireContract.js';

/** A selected execution target, never inferred from a filesystem path. Host project omission means
 * explicit host administration; managed projects always name their stable registry identity.
 *
 * The shape itself is declared in the wire contract, which the web compiles too; this file owns the
 * parser for it. The explicit annotation keeps the two in step: changing the schema without changing
 * the wire shape stops compiling here instead of reaching the web as an undeclared field. */
export const projectExecutionRefSchema: z.ZodType<ProjectExecutionRef> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host'), projectId: z.number().int().positive().optional() }).strict(),
  z.object({ kind: z.literal('managed'), projectId: z.number().int().positive() }).strict(),
]);
export type { ProjectExecutionRef };
export type ManagedProjectRef = Extract<ProjectExecutionRef, { kind: 'managed' }>;

export function sameProjectExecution(a: ProjectExecutionRef, b: ProjectExecutionRef): boolean {
  return a.kind === b.kind && a.projectId === b.projectId;
}

/** Single top-level guest directories a project mount may never take over, because the base image owns
 *  them. The sandbox plugin enforces this on the container itself (`guestMountTarget` in
 *  `plugins/sandbox/lib/containerSpec.mjs`); a project whose slug lands here would be created and could
 *  never start, so project creation refuses the slug instead. `tests/plugins/managedGuestRoot.test.ts`
 *  holds the two lists in step. */
export const RESERVED_GUEST_ROOTS: ReadonlySet<string> = new Set(['bin', 'boot', 'data', 'dev', 'etc', 'home', 'lib', 'lib32', 'lib64', 'libx32', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var', 'workspace', 'worktrees']);

/** The single directory name a slug is mounted under, before it is checked. */
function guestMountName(slug: string | undefined): string {
  return String(slug ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}

/** Whether a slug would mount over a base-image directory — the creation-time refusal. */
export function isReservedProjectSlug(slug: string): boolean {
  return RESERVED_GUEST_ROOTS.has(guestMountName(slug));
}

/** Where a managed project is mounted inside its own container, and therefore the only directory its
 *  turns ever see. Derived from the project slug so the agent, the tool rows and the container all name
 *  the same thing (`/kolin`) instead of an anonymous `/workspace`. Each project has its own container,
 *  so the name only has to be a valid single top-level directory; an unusable slug — and a slug that
 *  names a base-image directory, which the container refuses as a mount target — falls back to the
 *  registry identity, which is unique by construction and never reserved.
 *
 *  Creation refuses a reserved slug, so the fallback covers only rows that predate that refusal: without
 *  it such a project can be created and never started, and its slug is not patchable.
 *
 *  The sandbox plugin mirrors this function in `plugins/sandbox/lib/containerPaths.mjs` (a bundled
 *  plugin is plain `.mjs` and cannot import core at runtime); `tests/plugins/managedGuestRoot.test.ts`
 *  holds the two in step. */
export function managedGuestRoot(slug: string | undefined, projectId: number): string {
  const name = guestMountName(slug);
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && !RESERVED_GUEST_ROOTS.has(name) ? `/${name}` : `/project-${projectId}`;
}
