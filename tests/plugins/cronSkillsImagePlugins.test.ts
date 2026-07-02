import { describe, it, expect } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');
const ADMIN: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const LIMITED: Policy = { allowedProjectIds: new Set([1]), allowedPaths: () => [] };
const asText = (r: { content: { text?: string }[] }) => (r.content[0] as { text: string }).text;

function freshDataRoot(): string { return mkdtempSync(join(tmpdir(), 'orca-pdata-')); }

describe('cronjob plugin', () => {
  it('parses schedules and computes due-ness', async () => {
    const { parseSchedule, isDue } = await import(join(pluginsDir, 'cronjob/index.mjs')) as {
      parseSchedule: (s: string) => { kind: string } | null;
      isDue: (j: { schedule: string; lastRun?: string }, now: number) => boolean;
    };
    expect(parseSchedule('every 15m')).toEqual({ kind: 'interval', ms: 900_000 });
    expect(parseSchedule('every 2h')).toEqual({ kind: 'interval', ms: 7_200_000 });
    expect(parseSchedule('daily 07:30')).toEqual({ kind: 'daily', hour: 7, minute: 30 });
    expect(parseSchedule('every 30s')).toBeNull(); // sub-minute refused
    expect(parseSchedule('nesmysl')).toBeNull();

    const now = new Date('2026-07-02T08:00:00Z').getTime();
    expect(isDue({ schedule: 'every 15m' }, now)).toBe(true); // never ran
    expect(isDue({ schedule: 'every 15m', lastRun: new Date(now - 60_000).toISOString() }, now)).toBe(false);
    expect(isDue({ schedule: 'every 15m', lastRun: new Date(now - 16 * 60_000).toISOString() }, now)).toBe(true);
  });

  it('cron_add/list/remove work in an admin session and are refused otherwise', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['cronjob'], dataRoot, logger: log });
    expect(reg.platforms.map((p) => p.name)).toEqual(['cron']);
    const add = reg.tools.find((t) => t.name === 'cron_add')!;
    const list = reg.tools.find((t) => t.name === 'cron_list')!;
    const remove = reg.tools.find((t) => t.name === 'cron_remove')!;

    await runWithPolicy(LIMITED, async () => {
      expect(asText(await add.execute('t', { name: 'x', schedule: 'every 15m', prompt: 'p' }, undefined as never, undefined as never))).toMatch(/admin session/);
    });
    await runWithPolicy(ADMIN, async () => {
      expect(asText(await add.execute('t', { name: 'ranní report', schedule: 'daily 07:30', prompt: 'shrň stav' }, undefined as never, undefined as never))).toMatch(/Scheduled/);
      expect(asText(await add.execute('t', { name: 'bad', schedule: 'every 5s', prompt: 'p' }, undefined as never, undefined as never))).toMatch(/invalid schedule/);
      const listed = asText(await list.execute('t', {}, undefined as never, undefined as never));
      expect(listed).toContain('ranní report');
      const jobs = JSON.parse(readFileSync(join(dataRoot, 'cronjob/jobs.json'), 'utf-8')) as { id: string }[];
      expect(asText(await remove.execute('t', { id: jobs[0]!.id }, undefined as never, undefined as never))).toMatch(/Removed/);
      expect(asText(await list.execute('t', {}, undefined as never, undefined as never))).toBe('No scheduled jobs.');
    });
  });
});

describe('skills plugin creator tools', () => {
  it('create → list → delete a user skill (admin only)', async () => {
    const dataRoot = freshDataRoot();
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['skills'], dataRoot, logger: log });
    const create = reg.tools.find((t) => t.name === 'create_skill')!;
    const list = reg.tools.find((t) => t.name === 'list_skills')!;
    const del = reg.tools.find((t) => t.name === 'delete_skill')!;

    await runWithPolicy(LIMITED, async () => {
      expect(asText(await create.execute('t', { name: 'x', description: 'd', content: 'c' }, undefined as never, undefined as never))).toMatch(/admin session/);
    });
    await runWithPolicy(ADMIN, async () => {
      expect(asText(await create.execute('t', { name: 'Bad Name', description: 'd', content: 'c' }, undefined as never, undefined as never))).toMatch(/kebab-case/);
      expect(asText(await create.execute('t', { name: 'deploy-checklist', description: 'Kdy nasazovat', content: 'Kroky…' }, undefined as never, undefined as never))).toMatch(/saved/);
      const file = join(dataRoot, 'skills/deploy-checklist.md');
      expect(readFileSync(file, 'utf-8')).toContain('name: deploy-checklist');
      expect(asText(await list.execute('t', {}, undefined as never, undefined as never))).toContain('deploy-checklist (user)');
      expect(asText(await del.execute('t', { name: 'deploy-checklist' }, undefined as never, undefined as never))).toMatch(/deleted/);
      expect(existsSync(file)).toBe(false);
    });
  });

  it('user-created skills register on the next plugin load', async () => {
    const dataRoot = freshDataRoot();
    const reg1 = await loadPlugins({ dirs: [pluginsDir], enabled: ['skills'], dataRoot, logger: log });
    const create = reg1.tools.find((t) => t.name === 'create_skill')!;
    await runWithPolicy(ADMIN, async () => {
      await create.execute('t', { name: 'novy-skill', description: 'test', content: 'obsah' }, undefined as never, undefined as never);
    });
    const reg2 = await loadPlugins({ dirs: [pluginsDir], enabled: ['skills'], dataRoot, logger: log });
    expect(reg2.skills.some((s) => s.name === 'novy-skill')).toBe(true);
  });
});

describe('image-gen plugin', () => {
  it('registers nothing without an API key, generates + saves a PNG with one', async () => {
    const dataRoot = freshDataRoot();
    const none = await loadPlugins({ dirs: [pluginsDir], enabled: ['image-gen'], dataRoot, logger: log });
    expect(none.tools).toHaveLength(0);

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }] }), { status: 200 })
    ) as typeof fetch;
    try {
      const reg = await loadPlugins({
        dirs: [pluginsDir], enabled: ['image-gen'], dataRoot, logger: log,
        config: { 'image-gen': { apiKey: 'sk-test' } },
      });
      const tool = reg.tools.find((t) => t.name === 'generate_image')!;
      const out = asText(await tool.execute('t', { prompt: 'orca ve vlnách' }, undefined as never, undefined as never));
      const m = /!\[.*\]\(\/api\/brain\/images\/([a-z0-9]+\.png)\)/.exec(out);
      expect(m).not.toBeNull();
      expect(readFileSync(join(dataRoot, 'image-gen', m![1]!), 'utf-8')).toBe('png-bytes');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
