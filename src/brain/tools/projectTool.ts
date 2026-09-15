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
    description: 'host for a host project or plain host administration; managed for a managed project environment.',
  }),
  projectId: Type.Optional(Type.Integer({
    minimum: 1,
    description: 'The Project id reported by action list. Required for kind managed; omit it only for plain host administration.',
  })),
}, {
  additionalProperties: false,
  description: 'Where to switch to. Required with action switch, rejected with action list.',
});

const projectToolInputType = Type.Object({
  action: Type.Unsafe<'list' | 'switch'>({
    type: 'string', enum: ['list', 'switch'],
    description: 'list reads the Projects allowed here; switch requests a new execution target.',
  }),
  target: Type.Optional(projectExecutionRefType),
}, { additionalProperties: false });

/** The three literal call shapes, written out for the model. They are the same JSON the schema above
 *  describes, and they exist because the schema alone cannot say that `target` belongs to `switch` only —
 *  a provider-compatible object schema has no way to express the discriminated union (see above), so the
 *  arrangement is stated in prose the model reads instead. Also repeated in the refusal messages, which is
 *  where a model that got it wrong actually looks. */
const CALL_SHAPES =
  '{"action":"list"} · {"action":"switch","target":{"kind":"host"}} · '
  + '{"action":"switch","target":{"kind":"managed","projectId":123}}';

const DESCRIPTION =
  'List Projects allowed to this conversation, or request switching its execution target. '
  + `Exactly three call shapes are valid: ${CALL_SHAPES}. `
  + 'Add "projectId" inside target for kind host to name a host project; kind managed always requires it. '
  + 'Never put "projectId" at the top level, and never send "target" with action list. '
  + 'Ids come from action list. A switch applies after the current tool batch and never starts an environment.';

const result = (details: object) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(details) }],
  details,
});
const unavailable = () => result({
  ok: false as const,
  message: 'The requested Project is not available in this conversation.',
});

/** At most three argument names, each clamped, so a refusal names what was wrong without echoing an
 *  arbitrary amount of model-authored text back into the transcript. */
function nameKeys(keys: readonly string[]): string {
  const shown = keys.slice(0, 3).map((key) => `"${key.slice(0, 40)}"`);
  return keys.length > shown.length ? `${shown.join(', ')} and ${keys.length - shown.length} more` : shown.join(', ');
}

/** Why the arguments were refused, in terms the model can act on.
 *
 *  `projectToolInputSchema` stays the authority — this reads the SAME raw input a second time only to
 *  choose a sentence, and it never reports a Zod issue dump: the paths in one are internal union-branch
 *  detail ("expected literal list at action" for a switch call) that misleads more than it helps. Each
 *  branch here is a mistake models actually make against this tool, chiefly because the public schema
 *  cannot state the discriminated union it is checked against. */
function invalidInputMessage(raw: unknown): string {
  const shapes = `Valid shapes: ${CALL_SHAPES}.`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `Project takes a JSON object. ${shapes}`;
  const input = raw as Record<string, unknown>;
  const action = input.action;
  if (action !== 'list' && action !== 'switch') {
    return `"action" must be "list" or "switch". ${shapes}`;
  }
  if (action === 'list') {
    const extra = Object.keys(input).filter((key) => key !== 'action');
    return `action "list" takes no other argument, so drop ${nameKeys(extra)}. `
      + 'Call {"action":"list"} first and switch to one of the targets it reports.';
  }
  const target = input.target;
  if (target === undefined || target === null) {
    const misplaced = Object.keys(input).filter((key) => key === 'kind' || key === 'projectId');
    return misplaced.length > 0
      ? `${nameKeys(misplaced)} must be nested inside "target", not sent at the top level. ${shapes}`
      : `action "switch" requires a "target". ${shapes}`;
  }
  if (typeof target !== 'object' || Array.isArray(target)) return `"target" must be a JSON object. ${shapes}`;
  const ref = target as Record<string, unknown>;
  if (ref.kind !== 'host' && ref.kind !== 'managed') {
    return `"target.kind" must be "host" or "managed". ${shapes}`;
  }
  if (ref.kind === 'managed' && !(typeof ref.projectId === 'number' && Number.isInteger(ref.projectId) && ref.projectId > 0)) {
    return 'kind "managed" requires "projectId" inside "target", a positive integer id from action list. '
      + 'Example: {"action":"switch","target":{"kind":"managed","projectId":123}}.';
  }
  const extra = Object.keys(ref).filter((key) => key !== 'kind' && key !== 'projectId');
  return extra.length > 0
    ? `"target" accepts only "kind" and "projectId", so drop ${nameKeys(extra)}. ${shapes}`
    : `Project arguments were not valid. ${shapes}`;
}

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
    description: DESCRIPTION,
    parameters: projectToolInputType,
    execute: async (_toolCallId: string, raw: unknown) => {
      const parsed = projectToolInputSchema.safeParse(raw);
      if (!parsed.success) return result({ ok: false as const, message: invalidInputMessage(raw) });
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
