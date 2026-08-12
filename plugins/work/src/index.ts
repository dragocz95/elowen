/** work — the task domain as a plugin.
 *
 *  It owns the task tracking vertical: the `tasks` / `task_deps` / `task_usage` tables (ctx.db().migrate
 *  — see store/migrations.ts), the stores over them, and the Elowen* control-plane tools that drive
 *  them. Disable it and an instance genuinely stops tracking work: the tables are not consulted, the
 *  daemon's task routes answer 503, and the tools are not advertised at all.
 *
 *  The domain is published as the `tasks` CONTROL rather than under this plugin's name, so the daemon
 *  and the agents plugin ask for a domain and never for "work" — the missions subsystem is built on
 *  task rows and reaches them through that control (host stores seam), refusing honestly when it is
 *  gone. Construction is LAZY: register() only registers, and the stores are built on first use, which
 *  keeps a sub-agent runner (which loads the plugin but never serves a request) from opening anything.
 */
import type { PluginContext, TasksDomainControl } from '../../../src/plugins/api.js';
import { WORK_MIGRATIONS } from './store/migrations.js';
import { TaskStore } from './store/taskStore.js';
import { Readiness } from './store/readiness.js';
import { TaskUsageStore } from './store/taskUsageStore.js';
import type { WorkDb } from './store/db.js';
import { registerWorkTools } from './tools.js';
import { WORK_MCP_TOOLS } from './mcpTools.js';

export function register(ctx: PluginContext): void {
  // Schema first: an ADOPTION of the grandfathered core tables — a no-op on every existing install,
  // and the sole creator on a fresh one. In the sub-agent runner ctx.db().migrate() is a logged no-op.
  ctx.db().migrate(WORK_MIGRATIONS);

  let stores: { tasks: TaskStore; readiness: Readiness; usage: TaskUsageStore } | null = null;
  const domain = () => {
    if (!stores) {
      const handle = ctx.db();
      // The ONE adaptation between the plugin database handle (transaction RUNS the function) and the
      // store code's better-sqlite3 idiom (transaction WRAPS it). Keeping the stores on the raw shape is
      // what makes them byte-identical to their core originals — and lets a test drive them over a plain
      // sqlite handle without a second adapter.
      const db: WorkDb = { prepare: (sql) => handle.prepare(sql), transaction: <T>(fn: () => T) => () => handle.transaction(fn) };
      stores = { tasks: new TaskStore(db), readiness: new Readiness(db), usage: new TaskUsageStore(db) };
    }
    return stores;
  };

  // The task domain itself. Registered under the DOMAIN key: whoever needs tasks (the daemon's tenancy
  // seam, the agents plugin's mission engine) asks for 'tasks' and gets whichever plugin owns it now.
  ctx.registerControl('tasks', {
    store: () => domain().tasks,
    readiness: () => domain().readiness,
    usage: () => domain().usage,
  } satisfies TasksDomainControl);

  // The control-plane brain tools (owner-gated at execute time, on the acting user's own credential)
  // and their MCP twins on the daemon's own /mcp server. Both are pure REST callers over the task
  // routes, so registering them touches no store — safe in the sub-agent runner too.
  registerWorkTools(ctx);
  for (const tool of WORK_MCP_TOOLS) ctx.registerMcpTool(tool);

  ctx.logger.info('work plugin loaded (task domain: tables, stores, Elowen* task tools)');
}
