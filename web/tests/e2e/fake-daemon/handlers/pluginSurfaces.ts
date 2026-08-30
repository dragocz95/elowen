// Canned daemon answers for the endpoints the REAL plugin bundles read, so a `/p/<plugin>` page can be
// measured with content in it rather than in its empty state.
//
// WHY IT IS SEPARATE from the seed fixtures: these are not core endpoints. Every path here is owned by a
// plugin and was previously swallowed by the server's `GET * -> []` catch-all, which is precisely why
// `/p/mcp` rendered its error boundary (`data.personal is not iterable`) and `/p/skills` rendered "no
// skills" — the pages loaded, and there was nothing on them a layout assertion could stand on.
//
// WHAT IT DOES NOT PROVE: the shapes below are structural mirrors of each plugin's own wire types, not
// the plugin's server code. They make the plugin's LAYOUT measurable; they do not verify that the plugin
// server actually returns this. A plugin that changes its wire format still has to be caught by its own
// repository's tests.
//
// Row counts are deliberate: the registers page at 20 (`PAGE_SIZE` in stats and cronjob), so the lists
// here are longer than that — a pager that is never rendered cannot be measured for reachability.
import type { Hono } from 'hono';
import type { Project } from '../../../../lib/types.ts';

const rows = <T>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i));

/** One project for the editor page. Not served from here: `/projects` is a core endpoint with its own
 *  seed default of `[]`, which other specs rely on, so a spec arms it with `seed.response('projects', …)`. */
export const EDITOR_PROJECT: Project = {
  id: 1, slug: 'atlas', path: '/srv/atlas', notes: 'E2E fixture project', icon: 'Folder',
};

/** The file the editor opens. Long enough that Monaco renders a real surface, short enough to stay cheap. */
const FILE_CONTENT = rows(40, (i) => `export const line${i} = ${i};`).join('\n');

export function registerPluginSurfaceRoutes(app: Hono): void {
  // --- mcp: the register of bridged servers. `canManageInstance` gates the instance scope. -----------
  app.get('/plugins/mcp/api/servers', (c) => c.json({
    canManageInstance: true,
    personal: rows(3, (i) => ({
      name: `personal-${i}`, scope: 'personal', transport: 'stdio', enabled: i % 2 === 0,
      status: i === 1 ? 'error' : 'connected', toolCount: i + 1,
      tools: rows(i + 1, (t) => ({ name: `tool_${i}_${t}`, description: 'A bridged tool.' })),
      lastError: i === 1 ? 'connection refused' : null, reconnecting: false,
      command: 'node', args: ['server.js'], env: {},
    })),
    instance: rows(4, (i) => ({
      name: `instance-${i}`, scope: 'instance', transport: i === 0 ? 'http' : 'stdio', enabled: true,
      status: 'connected', toolCount: 2,
      tools: rows(2, (t) => ({ name: `shared_${i}_${t}` })),
      lastError: null, reconnecting: false,
      ...(i === 0 ? { url: 'https://example.invalid/mcp' } : { command: 'python', args: ['-m', 'srv'], env: {} }),
    })),
  }));

  // --- skills: mixed rows on purpose. A one-word description next to a wrapping one is exactly the
  // shape that used to produce 27/41/59/59/49px rows against a 48px rhythm.
  app.get('/plugins/skills/list', (c) => c.json(rows(23, (i) => ({
    name: `skill-${String(i).padStart(2, '0')}`,
    description: i % 3 === 0
      ? 'Short.'
      : 'A considerably longer description that has every chance of wrapping onto a second line inside a narrow register column.',
    source: i % 4 === 0 ? 'bundled' : 'user',
    owner: i % 4 === 0 ? null : 1,
    canDelete: i % 4 !== 0,
    disableModelInvocation: i % 5 === 0,
    version: i % 4 === 0 ? 1 : null,
  }))));

  // --- subagent: the agents register. ---------------------------------------------------------------
  app.get('/plugins/agents/list', (c) => c.json(rows(8, (i) => ({
    name: `agent-${i}`,
    description: i % 2 === 0 ? 'Explores the codebase and reports back.' : 'Short.',
    tools: i % 3 === 0 ? 'read-only' : i % 3 === 1 ? 'all' : ['Read', 'Search'],
    source: i < 2 ? 'builtin' : 'user',
    canDelete: i >= 2,
  }))));

  // --- cronjob: scheduled jobs, past the 20-row page so the pager exists. ---------------------------
  app.get('/plugins/cronjob/jobs', (c) => c.json(rows(26, (i) => ({
    id: `job-${i}`,
    name: `Scheduled job ${i}`,
    schedule: i % 2 === 0 ? 'daily 07:30' : 'every 15m',
    prompt: 'Summarize what changed since the last run.',
    enabled: i % 3 !== 0,
    ownerUserId: i % 2 === 0 ? 1 : null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastRun: '2026-08-27T05:00:00.000Z',
    lastResult: 'ok',
  }))));

  // --- stats: model consumption, likewise past the page size. ---------------------------------------
  app.get('/usage/by-model', (c) => c.json(rows(27, (i) => ({
    exec: `provider-${i % 4}/model-${i}`,
    usage: {
      input: 1000 * (i + 1), output: 500 * (i + 1), cacheRead: 100 * i, cacheWrite: 20 * i,
      total: 1500 * (i + 1) + 120 * i,
      costUsd: i % 5 === 0 ? null : Number((0.01 * (i + 1)).toFixed(4)),
      costSource: 'calculated', outputTps: 40 + i, measuredOutput: 500 * (i + 1),
    },
  }))));
  // Relative days so the dashboard's trailing-30-day chart always has data in its window, with the
  // input/output/cache breakdown its tooltip states. Every seventh day is deliberately unpriced.
  app.get('/usage/by-day', (c) => c.json(rows(30, (i) => {
    const input = 2_000 * (i + 1);
    const output = 500 * (i + 1);
    const cacheRead = 8_000 * (i % 5);
    const cacheWrite = 400 * (i % 3);
    return {
      day: new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10),
      tokens: input + output + cacheRead + cacheWrite,
      input, output, cacheRead, cacheWrite,
      cost: i % 7 === 0 ? null : Number((0.15 * (i + 1)).toFixed(4)),
    };
  })));

  // --- todo: the per-conversation checklist behind the chat's task manager. Long on purpose: the modal
  // that shows it is the phone's FULLSCREEN overlay, and a list shorter than the viewport cannot prove
  // that its body scrolls to the last row. 30 rows overflow 844px comfortably.
  app.get('/plugins/todo/api/tasks', (c) => c.json({
    tasks: rows(30, (i) => ({
      id: String(i + 1),
      subject: `Task ${i + 1}`,
      description: i % 3 === 0
        ? 'A considerably longer task description that wraps onto a second line inside the narrow phone overlay.'
        : 'Short.',
      status: i % 5 === 0 ? 'completed' : i % 5 === 1 ? 'in_progress' : 'pending',
      ...(i % 5 === 1 ? { startedAt: Date.now() - 60_000 * (i + 1) } : {}),
      metadata: {},
      blockedBy: [],
      blocks: [],
    })),
  }));

  // --- editor: the project surfaces the file tree and the editor pane read. -------------------------
  app.get('/projects/:id/files', (c) => c.json([
    { path: 'src', type: 'dir' },
    { path: 'src/index.ts', type: 'file' },
    { path: 'src/util.ts', type: 'file' },
    { path: 'README.md', type: 'file' },
  ]));
  app.get('/projects/:id/file', (c) => c.json({ content: FILE_CONTENT, truncated: false }));
  app.get('/projects/:id/head', (c) => c.json({ content: FILE_CONTENT }));
  app.get('/projects/:id/changed', (c) => c.json({ changed: [] }));
  app.get('/projects/:id/changes', (c) => c.json({ diff: '' }));
  app.get('/projects/:id/git', (c) => c.json({ isRepo: false, status: null, remotes: [], branches: [], commits: [] }));
}
