import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkTools } from '../../../plugins/work/src/tools.js';

/** PROMPT-CACHE PARITY BASELINE for the seven Elowen* task tools that moved out of the core control
 *  plane (src/brain/tools/elowenTools.ts) into this plugin. What the model sees of a tool — its name,
 *  label, description and parameter schema — is part of the cached prompt prefix, so the extraction
 *  had to move those bytes unchanged, and any later edit has to be a decision rather than a slip.
 *  Verified against the pre-extraction file at 89725b3f when this baseline was written.
 *
 *  The existing name-only assertion in tools.test.ts sorts the names, so it cannot see a reworded
 *  description or a widened schema at all. This can. */
const BASELINE = 
[
  {
    "name": "ElowenListTasks",
    "label": "List tasks",
    "description": "List tasks in the Elowen projects, with each task's id, title, status and project. Optionally narrow to one project with project_id. Use it to see what work exists or is in progress, to find the next task after finishing one, or to get an overview before planning. Call it before ElowenCreateTask so you do not create a duplicate of a task that already exists.",
    "parameters": {
      "type": "object",
      "properties": {
        "project_id": {
          "type": "number",
          "description": "Only list tasks in this project"
        }
      }
    }
  },
  {
    "name": "ElowenCreateTask",
    "label": "Create task",
    "description": "Create a task in an Elowen project. Tasks are the unit of organized work — each belongs to a project and carries a title, a description and a status that tracks it through its lifecycle. Use this when the request is genuinely multi-step, when the work needs a visible checklist to stay on track, or when the user asks for it. Do not create a task for a single trivial action — just do the work. Check ElowenListTasks first to avoid duplicating an existing task. A new task starts `open`; move it through its lifecycle with ElowenUpdateTask as the work proceeds.",
    "parameters": {
      "type": "object",
      "required": [
        "title",
        "project_id"
      ],
      "properties": {
        "title": {
          "type": "string",
          "description": "A brief, actionable imperative naming the outcome, e.g. \"Fix the auth bug in the login flow\""
        },
        "project_id": {
          "type": "number",
          "description": "The project the task belongs to — tasks never exist standalone"
        },
        "description": {
          "type": "string",
          "description": "Context for what needs doing, with enough detail to resume the work after an interruption"
        }
      }
    }
  },
  {
    "name": "ElowenUpdateTask",
    "label": "Update task",
    "description": "Update an existing Elowen task: move it through its lifecycle, rename it, or revise its description. Status values are open, in_progress, blocked, closed, cancelled — set `in_progress` when you start the work and `closed` when it is genuinely finished, `blocked` when something outside your control stops it, and `cancelled` when it is no longer wanted. Only close a task you have actually completed: a partial implementation, a failing test or an unresolved error means it stays in_progress. Get the task id from ElowenListTasks or from what ElowenCreateTask returned.",
    "parameters": {
      "type": "object",
      "required": [
        "task_id"
      ],
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Id of the task to update (from ElowenListTasks or ElowenCreateTask)"
        },
        "status": {
          "anyOf": [
            {
              "type": "string",
              "const": "open"
            },
            {
              "type": "string",
              "const": "in_progress"
            },
            {
              "type": "string",
              "const": "blocked"
            },
            {
              "type": "string",
              "const": "closed"
            },
            {
              "type": "string",
              "const": "cancelled"
            }
          ],
          "description": "New lifecycle status"
        },
        "title": {
          "type": "string",
          "description": "Rename the task"
        },
        "description": {
          "type": "string",
          "description": "Replace the task description"
        }
      }
    }
  },
  {
    "name": "ElowenPlan",
    "label": "Plan a goal",
    "description": "Ask Elowen to break a goal into a task plan for a project.",
    "parameters": {
      "type": "object",
      "required": [
        "goal",
        "project_id"
      ],
      "properties": {
        "goal": {
          "type": "string"
        },
        "project_id": {
          "type": "number"
        }
      }
    }
  },
  {
    "name": "ElowenGetTask",
    "label": "Get task",
    "description": "Get a single task by its id, including its title, status, description, result summary, outcome, labels, dependencies and changed files. Use it to inspect a task's full state before updating or closing it.",
    "parameters": {
      "type": "object",
      "required": [
        "task_id"
      ],
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Id of the task to retrieve"
        }
      }
    }
  },
  {
    "name": "ElowenStopTask",
    "label": "Stop task",
    "description": "Stop a running task: revert its status to open (so it can be re-spawned) or cancel it entirely. If the task has a live agent session, that session is stopped first so a second agent cannot spawn alongside it. Use this when a task is stuck, producing wrong results, or no longer needed.",
    "parameters": {
      "type": "object",
      "required": [
        "task_id"
      ],
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Id of the task to stop"
        },
        "cancel": {
          "type": "boolean",
          "description": "Cancel the task permanently (default: revert to open for re-spawn)"
        }
      }
    }
  },
  {
    "name": "ElowenTaskOutput",
    "label": "Task output",
    "description": "Read a task's agent-reported result summary, outcome and token/cost usage. Returns the result_summary and outcome the agent recorded when it closed the task, plus usage statistics (or \"no usage recorded\" when none exists). Use it to review what a completed task actually did.",
    "parameters": {
      "type": "object",
      "required": [
        "task_id"
      ],
      "properties": {
        "task_id": {
          "type": "string",
          "description": "Id of the task to read output from"
        }
      }
    }
  }
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('work plugin tool parity (prompt cache)', () => {
  const tools = buildWorkTools({ url: 'http://x', token: 't' });

  it('advertises exactly the baseline tools, in the baseline order', () => {
    // Order matters as much as content: it is the order they enter the advertised set, and the
    // plan-mode/plugin composition downstream depends on it.
    expect(tools.map((t) => t.name)).toEqual(BASELINE.map((b) => b.name));
  });

  it('advertises each of them byte-identical to what core shipped', () => {
    for (const b of BASELINE) {
      const t = tools.find((x) => x.name === b.name)!;
      expect(`${b.name}.label = ${t.label}`).toBe(`${b.name}.label = ${b.label}`);
      expect(t.description).toBe(b.description);
      // The schema reaches the model as JSON — compare the serialized form, since typebox carries
      // extra symbols that never travel on the wire.
      expect(JSON.parse(JSON.stringify(t.parameters))).toEqual(b.parameters);
    }
  });

  it('declares in the manifest exactly the tools it registers', () => {
    // A tool missing from provides.tools is refused at registration; one listed but never registered
    // is a manifest that promises what the plugin does not deliver.
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'plugins/work/elowen-plugin.json'), 'utf8')) as { provides: { tools: string[] }; planSafe?: string[] };
    expect([...manifest.provides.tools].sort()).toEqual(tools.map((t) => t.name).sort());
    // planSafe may only name tools that exist, and only ones that are genuinely read-only.
    for (const name of manifest.planSafe ?? []) expect(tools.map((t) => t.name)).toContain(name);
    expect(manifest.planSafe).toEqual(['ElowenListTasks']);
  });
});
