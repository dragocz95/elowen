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
