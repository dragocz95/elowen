import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export function registerEnvironmentTools(ctx, control) {
  const projectId = Type.Integer({ minimum: 1, description: 'Accessible managed Project id.' });
  const register = (name, description, fields, execute) => ctx.registerTool(defineTool({ name, label: name, description,
    parameters: Type.Object({ projectId, ...fields }), execute: async (_id, input) => {
      try {
        const actor = { project: { kind: 'managed', projectId: input.projectId }, accountUserId: ctx.currentAccountUserId() };
        const result = await execute(input, actor);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (cause) { return { content: [{ type: 'text', text: `Error: ${cause.message}` }], details: { ok: false, code: cause.code ?? 'environment_error' } }; }
    } }));
  register('EnvironmentStatus', 'Read managed Project runtime state without starting it. Operation results are pending until daemon reconciliation reports completion.', {}, (input, actor) => control.environmentFor(actor));
  const generation = { expectedGeneration: Type.Optional(Type.Integer({ minimum: 1 })), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: 'Reuse the same id when retrying an interrupted intent.' })) };
  for (const [name, kind] of [['EnvironmentStart', 'start'], ['EnvironmentStop', 'stop']]) register(name,
    kind === 'start' ? 'Request an explicit start of the persistent managed environment. Existing files and services are preserved.' : 'Request a stop of the managed environment. This interrupts shared project services and executions; confirm the action with the user first.',
    generation, (input, actor) => control.requestEnvironment({ ...actor, ...input, action: { kind } }));
  register('EnvironmentSnapshot', 'Request a crash-consistent snapshot of root filesystem, HOME, workspace and data. This is not a database-consistent backup.', { ...generation, note: Type.Optional(Type.String({ maxLength: 2000 })) },
    (input, actor) => control.requestEnvironment({ ...actor, ...input, action: { kind: 'snapshot', note: input.note } }));
  register('EnvironmentRestore', 'Restore a retained snapshot into a fresh runtime generation. This replaces the active project state and interrupts services. Obtain explicit user confirmation first.', { ...generation, snapshotId: Type.String({ minLength: 1, maxLength: 64 }) },
    (input, actor) => control.requestEnvironment({ ...actor, ...input, action: { kind: 'restore', snapshotId: input.snapshotId } }));
  register('EnvironmentLogs', 'Read bounded managed environment lifecycle logs and the guest system journal.', { lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }, (input, actor) => control.environmentLogs({ ...actor, lines: input.lines }));
  register('EnvironmentOperation', 'Read the actual status of a previously requested lifecycle operation. A pending request is not a completed action.', { operationId: Type.String({ minLength: 1 }) }, (input, actor) => control.environmentOperation({ operationId: input.operationId, accountUserId: actor.accountUserId }));
  register('EnvironmentWorktrees', 'List or manage organizational Git worktrees inside a shared managed Project. These are not security-isolated workspaces and do not bind the conversation.', {
    action: Type.Union([Type.Object({ kind: Type.Literal('list') }), Type.Object({ kind: Type.Literal('create'), label: Type.String({ minLength: 1, maxLength: 80 }), baseRef: Type.String({ minLength: 1, maxLength: 200 }) }), Type.Object({ kind: Type.Literal('remove'), workspaceId: Type.String({ minLength: 1 }) })]),
  }, (input, actor) => control.managedWorktrees({ ...actor, action: input.action }));
}
