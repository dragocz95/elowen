import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { callElowenApi } from '../../shared/apiClient.js';

export interface ElowenToolCtx { url: string; token: string; fetchImpl?: typeof fetch }

/** Wrap a callElowenApi round-trip into the PI tool result shape. The raw JSON text is handed to the
 *  model — it reasons over it — so we return the API's own body verbatim (or a clear error line). */
async function call(ctx: ElowenToolCtx, method: string, path: string, body?: unknown) {
  const r = await callElowenApi(method, path, body, { url: ctx.url, token: ctx.token, fetchImpl: ctx.fetchImpl });
  const text = r.ok ? r.text : `Elowen API error HTTP ${r.status}: ${r.text}`;
  return { content: [{ type: 'text' as const, text }], details: {} };
}

/** The task lifecycle a tool caller may drive. Mirrors the REST `patchTaskSchema` enum exactly — a value
 *  outside it is rejected by the API, so keeping the two in step is what makes the tool's error messages
 *  honest. */
const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'closed', 'cancelled'] as const;
type TaskStatusArg = typeof TASK_STATUSES[number];

export function elowenListTasks(ctx: ElowenToolCtx) {
  return defineTool({
    name: 'ElowenListTasks', label: 'List tasks',
    description: [
      'List tasks in the Elowen projects, with each task\'s id, title, status and project. Optionally narrow to one project with project_id.',
      'Use it to see what work exists or is in progress, to find the next task after finishing one, or to get an overview before planning.',
      'Call it before ElowenCreateTask so you do not create a duplicate of a task that already exists.',
    ].join(' '),
    parameters: Type.Object({ project_id: Type.Optional(Type.Number({ description: 'Only list tasks in this project' })) }),
    execute: async (_id, p: { project_id?: number }) =>
      call(ctx, 'GET', p.project_id ? `/tasks?project_id=${p.project_id}` : '/tasks'),
  });
}

export function elowenCreateTask(ctx: ElowenToolCtx) {
  return defineTool({
    name: 'ElowenCreateTask', label: 'Create task',
    description: [
      'Create a task in an Elowen project. Tasks are the unit of organized work — each belongs to a project and carries a title, a description and a status that tracks it through its lifecycle.',
      'Use this when the request is genuinely multi-step, when the work needs a visible checklist to stay on track, or when the user asks for it. Do not create a task for a single trivial action — just do the work.',
      'Check ElowenListTasks first to avoid duplicating an existing task. A new task starts `open`; move it through its lifecycle with ElowenUpdateTask as the work proceeds.',
    ].join(' '),
    parameters: Type.Object({
      title: Type.String({ description: 'A brief, actionable imperative naming the outcome, e.g. "Fix the auth bug in the login flow"' }),
      project_id: Type.Number({ description: 'The project the task belongs to — tasks never exist standalone' }),
      description: Type.Optional(Type.String({ description: 'Context for what needs doing, with enough detail to resume the work after an interruption' })),
    }),
    execute: async (_id, p: { title: string; project_id: number; description?: string }) =>
      call(ctx, 'POST', '/tasks', p),
  });
}

export function elowenUpdateTask(ctx: ElowenToolCtx) {
  return defineTool({
    name: 'ElowenUpdateTask', label: 'Update task',
    description: [
      'Update an existing Elowen task: move it through its lifecycle, rename it, or revise its description.',
      `Status values are ${TASK_STATUSES.join(', ')} — set \`in_progress\` when you start the work and \`closed\` when it is genuinely finished, \`blocked\` when something outside your control stops it, and \`cancelled\` when it is no longer wanted.`,
      'Only close a task you have actually completed: a partial implementation, a failing test or an unresolved error means it stays in_progress. Get the task id from ElowenListTasks or from what ElowenCreateTask returned.',
    ].join(' '),
    parameters: Type.Object({
      task_id: Type.String({ description: 'Id of the task to update (from ElowenListTasks or ElowenCreateTask)' }),
      status: Type.Optional(Type.Union(TASK_STATUSES.map((s) => Type.Literal(s)), { description: 'New lifecycle status' })),
      title: Type.Optional(Type.String({ description: 'Rename the task' })),
      description: Type.Optional(Type.String({ description: 'Replace the task description' })),
    }),
    execute: async (_id, p: { task_id: string; status?: TaskStatusArg; title?: string; description?: string }) => {
      const patch = {
        ...(p.status !== undefined ? { status: p.status } : {}),
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
      };
      // An empty PATCH would be a silent no-op that still reads as success — say so instead, so the model
      // learns it forgot the field rather than believing the task moved.
      if (Object.keys(patch).length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: nothing to update — pass at least one of status, title or description.' }], details: {} };
      }
      return call(ctx, 'PATCH', `/tasks/${encodeURIComponent(p.task_id)}`, patch);
    },
  });
}

export function elowenPlan(ctx: ElowenToolCtx) {
  return defineTool({
    name: 'ElowenPlan', label: 'Plan a goal',
    description: 'Ask Elowen to break a goal into a task plan for a project.',
    parameters: Type.Object({ goal: Type.String(), project_id: Type.Number() }),
    execute: async (_id, p: { goal: string; project_id: number }) => call(ctx, 'POST', '/tasks/plan', p),
  });
}

export function elowenListMissions(ctx: ElowenToolCtx) {
  return defineTool({
    name: 'ElowenListMissions', label: 'List missions',
    description: 'List Elowen autopilot missions.',
    parameters: Type.Object({}),
    execute: async () => call(ctx, 'GET', '/missions'),
  });
}

export function elowenListSessions(ctx: ElowenToolCtx) {
  return defineTool({
    name: 'ElowenListSessions', label: 'List sessions',
    description: 'List live Elowen agent sessions.',
    parameters: Type.Object({}),
    execute: async () => call(ctx, 'GET', '/sessions'),
  });
}
