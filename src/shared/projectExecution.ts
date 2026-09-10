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

/** Where a managed project is mounted inside its own container, and therefore the only directory its
 *  turns ever see. Derived from the project slug so the agent, the tool rows and the container all name
 *  the same thing (`/kolin`) instead of an anonymous `/workspace`. Each project has its own container,
 *  so the name only has to be a valid single top-level directory; an unusable slug falls back to the
 *  registry identity, which is unique by construction.
 *
 *  The sandbox plugin mirrors this function in `plugins/sandbox/lib/containerPaths.mjs` (a bundled
 *  plugin is plain `.mjs` and cannot import core at runtime); `tests/plugins/managedGuestRoot.test.ts`
 *  holds the two in step. */
export function managedGuestRoot(slug: string | undefined, projectId: number): string {
  const name = String(slug ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  return /^[a-z0-9][a-z0-9-]*$/.test(name) ? `/${name}` : `/project-${projectId}`;
}
