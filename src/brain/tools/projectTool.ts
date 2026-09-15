import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { projectExecutionRefSchema, sameProjectExecution, type ProjectExecutionRef } from '../../shared/projectExecution.js';
import type { Policy } from '../../plugins/policy.js';
import { currentAccountUserId, currentSessionId, currentTurnMode } from '../../plugins/policyContext.js';
import type { ProjectStore } from '../../store/projectStore.js';
import { selectableProjectTargets } from '../service/workDir.js';

export const projectToolInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('switch'), target: projectExecutionRefSchema }).strict(),
]);

const projectExecutionRefType = Type.Union([
  Type.Object({ kind: Type.Literal('host'), projectId: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('managed'), projectId: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
]);

const projectToolInputType = Type.Union([
  Type.Object({ action: Type.Literal('list') }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('switch'), target: projectExecutionRefType }, { additionalProperties: false }),
]);

const result = (details: object) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(details) }],
  details,
});
const unavailable = () => result({
  ok: false as const,
  message: 'The requested Project is not available in this conversation.',
});

export interface ProjectToolDeps {
  sessionId: string;
  ownerUserId: number;
  policy: () => Policy | undefined;
  projects?: ProjectStore;
  current: () => ProjectExecutionRef | undefined;
  request: (target: ProjectExecutionRef) => 'pending' | 'unchanged';
  canSwitch: () => boolean;
}

export function buildProjectTool(deps: ProjectToolDeps | undefined) {
  return defineTool({
    name: 'Project',
    label: 'Project',
    description: 'List Projects allowed to this conversation or request switching its execution target. A switch applies after the current tool batch and never starts an environment.',
    parameters: projectToolInputType,
    execute: async (_toolCallId: string, raw: unknown) => {
      const parsed = projectToolInputSchema.safeParse(raw);
      if (!parsed.success) return result({ ok: false as const, message: 'Invalid Project input.' });
      if (!deps) return result({ ok: false as const, message: 'Project control is unavailable in this session.' });
      const action = parsed.data.action;
      const accountUserId = currentAccountUserId();
      if (accountUserId === null || accountUserId !== deps.ownerUserId || currentSessionId() !== deps.sessionId) {
        return result({ ok: false as const, message: 'Project control requires this conversation\'s linked account session.' });
      }
      if (action === 'list') {
        const policy = deps.policy();
        if (!policy) return result({ ok: false as const, message: 'Project control is unavailable in this session.' });
        const current = deps.current();
        return result({
          ok: true as const,
          action,
          current,
          projects: selectableProjectTargets(policy, deps.projects),
        });
      }
      if (!deps.canSwitch() || currentTurnMode() === 'plan') {
        return result({ ok: false as const, message: 'Project switching is not available in this session mode.' });
      }
      const policy = deps.policy();
      const target = parsed.data.target;
      const selectable = selectableProjectTargets(policy ?? { allowedProjectIds: new Set(), allowedPaths: () => [] }, deps.projects);
      if (!selectable.some((candidate) => sameProjectExecution(candidate.executionRef, target))) return unavailable();
      try {
        const status = deps.request(target);
        if (status === 'unchanged') return result({ ok: true as const, action, status, current: deps.current() });
        return result({ ok: true as const, action, status, current: deps.current(), requested: target, effectiveAt: 'next-model-step' as const });
      } catch (error) {
        return result({ ok: false as const, message: error instanceof Error ? error.message : 'Project switch was refused.' });
      }
    },
  });
}
