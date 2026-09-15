import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { buildContributionReport, emptyContributionReport, pluginContributions } from '../../src/plugins/contributionReport.js';
import { installStepContext, type StepContextInfo } from '../../src/brain/session/stepContext.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** `ctx.registerStepContext` end to end across the plugin boundary: a real plugin on disk registers a
 *  mid-turn provider, and the contribution has to survive the whole chain the daemon reads it through —
 *  `contextFor` → `mergeFrom` → the runtime contribution report → the session seam that calls it.
 *
 *  A FIXTURE is the right subject, not the todo plugin: the rule under test is the daemon's, and pinning
 *  it to a product plugin would make it fail for reasons that have nothing to do with it. Note the
 *  manifest declares NO capabilities: like turn context, a step reminder rides the ephemeral prompt and
 *  leaves nothing durable behind, so it needs no `mutates` grant. */

const log = { info() {}, warn() {}, error() {} };
let dirs: string[] = [];
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

/** Write one plugin into a throwaway scan root and load it alone, so every contribution in the registry
 *  is unambiguously its own. */
async function load(body: string, name = 'stepwise') {
  const root = mkdtempSync(join(tmpdir(), 'elowen-step-context-'));
  dirs.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name, version: '1.0.0', apiVersion: '1', description: `fixture ${name}`, entry: 'index.mjs',
  }));
  writeFileSync(join(dir, 'index.mjs'), `export function register(ctx){\n${body}\n}\n`);
  return loadPlugins({ dirs: [root], enabled: [name], dataRoot: mkdtempSync(join(tmpdir(), 'elowen-step-data-')), logger: log });
}

const REGISTRATION = [
  "ctx.registerStepContext((info) => 'TASK 7 still in_progress after ' + info.toolCalls + ' calls');",
  'ctx.registerStepContext(() => { throw new Error("provider blew up"); });',
].join('\n');

interface Msg { role?: string; content?: unknown; isMeta?: boolean }
type Handler = (event: { messages: unknown }) => Promise<{ messages: unknown } | undefined>;

/** Canonical history of a turn that has made `calls` tool calls, one per assistant/tool pair. */
function turnWith(calls: number): Msg[] {
  const messages: Msg[] = [{ role: 'user', content: 'do the thing' }];
  for (let n = 1; n <= calls; n += 1) {
    messages.push(
      { role: 'assistant', content: [{ type: 'toolCall', id: `c${n}`, name: 'Bash', arguments: {} }] },
      { role: 'toolResult', content: `output ${n}` },
    );
  }
  return messages;
}

/** Drive the seam over a real registry's contributions, the way `spawner.ts` hands them to a session. */
async function fireOnce(registry: PluginRegistry, calls: number): Promise<Msg[]> {
  let handler: Handler = async () => undefined;
  const pi = { on: (event: string, fn: Handler) => { if (event === 'context') handler = fn; } } as unknown as ExtensionAPI;
  installStepContext(pi, {
    sessionId: 'brain-step-context-registry-test',
    every: () => calls,
    providers: () => registry.stepContexts,
  });
  const messages = turnWith(calls);
  const out = await handler({ messages });
  return (out?.messages as Msg[] | undefined) ?? messages;
}

describe('ctx.registerStepContext', () => {
  it('lands in the registry with its owning plugin and receives the turn position', async () => {
    const registry = await load(REGISTRATION);

    expect(registry.stepContexts).toHaveLength(2);
    expect(registry.stepContextOwners).toEqual(['stepwise', 'stepwise']);
    // It is NOT a turn context: registering a step provider contributes nothing to the per-turn seam.
    expect(registry.turnContexts).toEqual([]);

    const info: StepContextInfo = { toolCalls: 40 };
    expect(await registry.stepContexts[0]!.render(info)).toBe('TASK 7 still in_progress after 40 calls');
  });

  it('survives mergeFrom with its owner, and is named by the contribution report', async () => {
    const staged = await load(REGISTRATION);
    const merged = new PluginRegistry();
    merged.merge(staged);

    expect(merged.stepContexts).toHaveLength(2);
    expect(merged.stepContextOwners).toEqual(['stepwise', 'stepwise']);
    expect(buildContributionReport(merged).stepContexts).toEqual([{ plugin: 'stepwise' }, { plugin: 'stepwise' }]);
    expect(pluginContributions(merged, 'stepwise').stepContexts).toEqual([{ plugin: 'stepwise' }, { plugin: 'stepwise' }]);
    expect(pluginContributions(merged, 'someone-else').stepContexts).toEqual([]);
    // The web renders the cadence row only when this list is non-empty, so the empty report must carry it.
    expect(emptyContributionReport().stepContexts).toEqual([]);
  });

  it('isolates a provider that throws, so one bad plugin cannot break another turn', async () => {
    const registry = await load(REGISTRATION);

    const out = await fireOnce(registry, 3);
    const injected = out.filter((m) => m.role === 'user' && m.isMeta === true);

    expect(injected).toHaveLength(1);
    const content = typeof injected[0]!.content === 'string' ? injected[0]!.content : '';
    expect(content).toContain('TASK 7 still in_progress after 3 calls');
    expect(content).not.toContain('provider blew up');
    // The healthy provider still ran even though its sibling is registered first and throws.
    expect(out[out.length - 1]).toBe(injected[0]);
  });
});
