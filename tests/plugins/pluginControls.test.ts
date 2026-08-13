import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { loadPlugins } from '../../src/plugins/loader.js';
import type { PluginCapabilities, PluginControl, TasksDomainControl } from '../../src/plugins/api.js';

const noopLog = { info() {}, warn() {}, error() {} };

/** A complete `tasks` domain control — only the three accessors matter here; what they return is the
 *  owner's business, so the fakes are minimal. */
const fakeTasksDomain = (): TasksDomainControl => ({
  store: () => ({ marker: 'store' }) as never,
  readiness: () => ({ marker: 'readiness' }) as never,
  usage: () => ({ marker: 'usage' }) as never,
});

/** Build a context whose `control()` resolves against `merged` — exactly how the loader wires it. */
function contextOver(merged: PluginRegistry, caps?: PluginCapabilities, warn?: (m: string) => void) {
  const staging = new PluginRegistry();
  const logger = warn ? { info() {}, warn, error() {} } : noopLog;
  return staging.contextFor(
    'consumer', {}, logger, undefined, undefined, undefined, undefined, caps, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (name) => merged.control(name),
  );
}

/** Register a control into a merged registry the way the loader does (stage, then merge). */
function ownerMerges(merged: PluginRegistry, owner: string, key: string, control: PluginControl): void {
  const staging = new PluginRegistry();
  staging.contextFor(owner, {}, noopLog).registerControl(key, control);
  merged.merge(staging);
}

describe('ctx.control — one plugin reaching another plugin domain', () => {
  it('is denied (and warned) without the controls read capability', () => {
    const merged = new PluginRegistry();
    ownerMerges(merged, 'work', 'tasks', fakeTasksDomain());
    const warnings: string[] = [];
    expect(contextOver(merged, {}, (m) => warnings.push(m)).control('tasks')).toBeUndefined();
    expect(warnings.join('\n')).toContain("control('tasks') denied");
    // A neighbouring grant must not open it either — this is its own capability, not a side effect.
    expect(contextOver(merged, { reads: ['stores'] }).control('tasks')).toBeUndefined();
  });

  it('hands the granted consumer the owner’s control', () => {
    const merged = new PluginRegistry();
    const domain = fakeTasksDomain();
    ownerMerges(merged, 'work', 'tasks', domain);
    expect(contextOver(merged, { reads: ['controls'] }).control('tasks')).toBe(domain);
  });

  it('answers undefined — never throws — when nobody owns the domain', () => {
    // The honest "the owner is switched off" state: the caller must be able to degrade, and an exception
    // on a legitimate configuration would instead take out whatever code path happened to ask.
    expect(contextOver(new PluginRegistry(), { reads: ['controls'] }).control('tasks')).toBeUndefined();
  });

  it('refuses a registration that does not carry the whole contract', () => {
    const merged = new PluginRegistry();
    // A half-built owner (say a partially initialised plugin) must not be handed over typed as the full
    // domain: the caller would then blow up at an arbitrary later call site instead of degrading here.
    ownerMerges(merged, 'work', 'tasks', { store: () => ({}), readiness: () => ({}) } as unknown as PluginControl);
    expect(contextOver(merged, { reads: ['controls'] }).control('tasks')).toBeUndefined();
  });

  it('resolves at CALL time, so a context built before the owner existed still sees it', () => {
    const merged = new PluginRegistry();
    const ctx = contextOver(merged, { reads: ['controls'] });
    expect(ctx.control('tasks')).toBeUndefined();
    const first = fakeTasksDomain();
    ownerMerges(merged, 'work', 'tasks', first);
    expect(ctx.control('tasks')).toBe(first);
  });
});

/** A control BUILT ON another plugin's domain (missions are made of tasks). The failure this prevents is
 *  a dependent subsystem that stays reachable after its foundation is switched off: every accessor then
 *  throws inside whichever request touched it, and callers — which all have a "the plugin is disabled"
 *  path already — never get to take it. */
describe('a control that declares the domain it is built on', () => {
  /** Stage + merge a dependent control the way the loader does. */
  const ownerMergesDependent = (merged: PluginRegistry, requires: string) => {
    const staging = new PluginRegistry();
    staging.contextFor('agents', {}, noopLog).registerControl('agents', fakeAgentsControl(), { requires });
    merged.merge(staging);
  };
  /** Every method KNOWN_CONTROL_METHODS.agents demands — the shape check must not be what fails here. */
  const fakeAgentsControl = (): PluginControl => Object.fromEntries(
    ['engine', 'spawn', 'planFlow', 'planJobs', 'decisionQueue', 'missionGit', 'agents', 'gitLock',
      'missions', 'liveTaskUsage', 'detectClis', 'advisor', 'onTaskClosed'].map((m) => [m, () => ({})]),
  ) as PluginControl;

  it('does not resolve while that domain has no owner', () => {
    const merged = new PluginRegistry();
    ownerMergesDependent(merged, 'tasks');
    expect(merged.control('agents')).toBeUndefined();
  });

  it('resolves once the domain has one, and stops again if it goes away', () => {
    const merged = new PluginRegistry();
    ownerMergesDependent(merged, 'tasks');
    ownerMerges(merged, 'work', 'tasks', fakeTasksDomain());
    expect(merged.control('agents')).toBeDefined();
    // A reload that drops the owner must take the dependent with it — resolution is live, not a snapshot
    // taken when the dependency happened to be there.
    merged.controls.delete('tasks');
    expect(merged.control('agents')).toBeUndefined();
  });

  it('is not satisfied by an owner that only half implements the domain', () => {
    const merged = new PluginRegistry();
    ownerMergesDependent(merged, 'tasks');
    ownerMerges(merged, 'work', 'tasks', { store: () => ({}) } as unknown as PluginControl);
    // The dependent would be handed a domain whose readiness()/usage() are missing — the same "blows up
    // at an arbitrary later call site" the shape check exists to prevent, one level removed.
    expect(merged.control('agents')).toBeUndefined();
  });

  it('leaves a control that declares nothing alone', () => {
    const merged = new PluginRegistry();
    const staging = new PluginRegistry();
    staging.contextFor('agents', {}, noopLog).registerControl('agents', fakeAgentsControl());
    merged.merge(staging);
    expect(merged.control('agents')).toBeDefined(); // no dependency declared, no gate
  });
});

describe('ctx.control through the real loader', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'elowen-controls-'));
    const plugin = (name: string, body: string, extra: Record<string, unknown> = {}) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
        name, version: '0.1.0', apiVersion: '1', description: name, entry: 'index.mjs', ...extra,
      }));
      writeFileSync(join(dir, 'index.mjs'), body);
    };
    // 'aconsumer' sorts BEFORE 'zowner', so the loader registers it while the owner does not yet exist —
    // the exact ordering that makes a register-time lookup impossible and a call-time one work.
    plugin('aconsumer', `export function register(ctx){
      globalThis.__controlProbe = () => ctx.control('tasks');
      ctx.registerSystemPromptFragment('at-register:' + (ctx.control('tasks') === undefined ? 'absent' : 'present'));
    }`, { capabilities: { reads: ['controls'] } });
    plugin('zowner', `export function register(ctx){
      ctx.registerControl('tasks', { store: () => 'S', readiness: () => 'R', usage: () => 'U' });
    }`);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    delete (globalThis as { __controlProbe?: unknown }).__controlProbe;
  });

  it('a consumer loaded BEFORE the owner still resolves it once loading finished', async () => {
    const reg = await loadPlugins({ dirs: [root], enabled: ['aconsumer', 'zowner'], logger: noopLog });
    // Proof the ordering problem is real and not accidentally avoided: at its own register() the owner
    // was genuinely absent…
    expect(reg.promptFragments).toContain('at-register:absent');
    // …yet the same context resolves the domain now that every plugin has merged.
    const probe = (globalThis as { __controlProbe?: () => TasksDomainControl | undefined }).__controlProbe;
    expect(probe?.()?.store()).toBe('S');
  });
});
