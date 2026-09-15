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

/** The PUBLIC (provider-facing) shape. It is deliberately a single top-level object with plain string
 *  enums, not the discriminated union the arguments actually satisfy.
 *
 *  A union renders as a top-level `anyOf`, and an OpenAI-compatible Responses endpoint that is not
 *  OpenAI itself rejects the whole request over it: Alibaba's compatible-mode endpoint answers
 *  `InternalError.Algo.InvalidParameter: The parameters, when provided as a dict, must confirm to a
 *  valid openai-compatible JSON schema … for tool: Project` and the turn cannot run at all. The same
 *  applies to the nested target union, so `kind` is an enum and `projectId` is optional here.
 *
 *  Loosening the ADVERTISED schema loosens nothing that matters: `projectToolInputSchema` below is the
 *  authoritative validator and still rejects `list` with a target, `switch` without one, and a managed
 *  target with no `projectId`. The description states those invariants for the model. */
const projectExecutionRefType = Type.Object({
  kind: Type.Unsafe<ProjectExecutionRef['kind']>({
    type: 'string', enum: ['host', 'managed'],
    description: 'Execution target kind, as reported by action list.',
  }),
  projectId: Type.Optional(Type.Integer({
    minimum: 1,
    description: 'Required for kind managed; may be omitted for kind host to mean plain host administration.',
  })),
}, {
  additionalProperties: false,
  description: 'Required with action switch and rejected with action list.',
});

const projectToolInputType = Type.Object({
  action: Type.Unsafe<'list' | 'switch'>({
    type: 'string', enum: ['list', 'switch'],
    description: 'list takes no target; switch requires one.',
  }),
  target: Type.Optional(projectExecutionRefType),
}, { additionalProperties: false });

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
