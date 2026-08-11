import { join } from 'node:path';
import { setPluginPromptSources } from '../../src/prompts/index.js';
import { setPluginPromptCatalog } from '../../src/prompts/catalog.js';
import { AGENTS_PROMPTS, AGENTS_PROMPTS_DIR } from '../../plugins/agents/src/promptCatalog.js';

// The agents plugin owns the worker*/agent-guide*/pilot/overseer/code-review/decision-* templates.
// In production the daemon installs the plugin prompt overlay right after loading plugins
// (brainCore), so the core renderer NEVER resolves those names without it. Install the same overlay
// for every test file — a test that exercises overlay mechanics still swaps it out itself.
setPluginPromptCatalog(AGENTS_PROMPTS.map((e) => ({ ...e })));
setPluginPromptSources(new Map(AGENTS_PROMPTS.map((e) => [e.name, join(AGENTS_PROMPTS_DIR, `${e.name}.md`)])));
