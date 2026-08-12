import type { PluginContext } from '../../../../src/plugins/api.js';
import { createSkillService, type SkillService } from '../services/skillService.js';
import { logger } from '../lib/logger.js';

const log = logger('skills');

/** The grandfathered '/system/skills' surface: install/verify the bundled `elowen-workflow` SKILL.md
 *  across the agent CLIs' skills dirs (claude-code/codex/opencode) — the workflow guide the CLIs this
 *  plugin SPAWNS read natively, which is why it lives here and not in the skills plugin (that one owns
 *  the brain's own prompt skills). Admin access uses the setup-tolerant gate, mirroring the core
 *  /system/* routes it sat beside. */
export function registerSkillsApi(ctx: PluginContext): void {
  // Stateless (resolves HOME + provider dirs per call), constructed once per registration.
  const service: SkillService = createSkillService();

  // Startup self-heal, previously bootstrap's own step: (re)install the master into every present
  // provider on boot and on plugin reload. Best-effort — installAll catches per-provider errors.
  // Skipped under vitest (the old guard was the in-memory test DB): a test run must not write into
  // the runner's real HOME config dirs.
  ctx.registerBootReconcile(() => {
    if (process.env.VITEST) return;
    const done = service.installAll().filter((r) => r.installed).map((r) => r.provider);
    if (done.length) log.info(`installed elowen-workflow skill for: ${done.join(', ')}`);
  });

  ctx.registerApiRoute({
    rootMount: '/system/skills', path: '', method: 'GET', access: 'admin',
    handler: async (req) => (req.path === '' ? { status: 200, body: { skills: service.status() } } : { status: 404, body: { error: 'not found' } }),
  });
  ctx.registerApiRoute({
    rootMount: '/system/skills/install', path: '', method: 'POST', access: 'admin',
    handler: async (req) => (req.path === '' ? { status: 200, body: { results: service.installAll() } } : { status: 404, body: { error: 'not found' } }),
  });
}
