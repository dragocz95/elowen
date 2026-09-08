import { z } from 'zod';

/** A selected execution target, never inferred from a filesystem path. Host project omission means
 * explicit host administration; managed projects always name their stable registry identity. */
export const projectExecutionRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host'), projectId: z.number().int().positive().optional() }).strict(),
  z.object({ kind: z.literal('managed'), projectId: z.number().int().positive() }).strict(),
]);
export type ProjectExecutionRef = z.infer<typeof projectExecutionRefSchema>;
export type ManagedProjectRef = Extract<ProjectExecutionRef, { kind: 'managed' }>;

export function sameProjectExecution(a: ProjectExecutionRef, b: ProjectExecutionRef): boolean {
  return a.kind === b.kind && a.projectId === b.projectId;
}
