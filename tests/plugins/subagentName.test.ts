import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { SubagentUpdate } from '../../src/brain/events.js';
import { resolveSubagentName } from '../../plugins/subagent/lib/name.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };

/** Every rail row used to be labelled with the child's whole task text, which is a paragraph, so the row
 *  read as a wall of prose the reader had to parse to tell one running child from another. A delegation
 *  now carries a short NAME instead: the parent may pass one, and when it does not the host derives one
 *  from the task's opening words so a row is never left unlabelled. */
describe('subagent plugin — a delegation carries a short name', () => {
  describe('the derivation rule', () => {
    it('keeps an explicit name the parent passed', () => {
      expect(resolveSubagentName('ship-audit', 'Audit what is left before this branch can ship')).toBe('ship-audit');
    });

    it('trims an explicit name rather than rendering its padding', () => {
      expect(resolveSubagentName('  ship-audit  ', 'anything')).toBe('ship-audit');
    });

    it('derives the opening words of the task when the parent passed none', () => {
      expect(resolveSubagentName(undefined, 'Audit the migration for safety and report back'))
        .toBe('Audit the migration for safety');
    });

    it('derives from the task for an explicit name that is only whitespace', () => {
      expect(resolveSubagentName('   ', 'Audit the migration for safety and report back'))
        .toBe('Audit the migration for safety');
    });

    it('collapses newlines and runs of spaces, so a formatted briefing still yields one line', () => {
      expect(resolveSubagentName(undefined, '  Review\n\n  the   auth  boundary\nand report')).toBe('Review the auth boundary and');
    });

    it('drops trailing punctuation, which reads as a truncation artefact on a row', () => {
      expect(resolveSubagentName(undefined, 'Fix the parser crash.')).toBe('Fix the parser crash');
    });

    it('drops the punctuation a word-boundary clip lands on', () => {
      expect(resolveSubagentName(undefined, 'Reconcile the delegation lifecycle, bookkeeping and rows'))
        .toBe('Reconcile the delegation lifecycle');
    });

    it('clips a name whose opening words are long, on a word boundary', () => {
      const name = resolveSubagentName(undefined, 'Reconcile the delegation lifecycle bookkeeping thoroughly');

      expect(name.length).toBeLessThanOrEqual(40);
      expect(name).toBe('Reconcile the delegation lifecycle');
    });

    it('clips a single word longer than the whole budget', () => {
      const name = resolveSubagentName(undefined, 'x'.repeat(120));

      expect(name).toBe('x'.repeat(40));
    });

    it('clips an over-long explicit name to the same budget', () => {
      expect(resolveSubagentName('n'.repeat(120), 'a task')).toBe('n'.repeat(40));
    });

    it('returns an empty name for a task with no words, rather than inventing one', () => {
      expect(resolveSubagentName(undefined, '   ')).toBe('');
    });
  });

  describe('the progress payload', () => {
    let dataRoot: string;
    let updates: SubagentUpdate[];

    beforeEach(() => {
      dataRoot = mkdtempSync(join(tmpdir(), 'subagent-name-'));
      updates = [];
    });

    afterEach(() => rmSync(dataRoot, { recursive: true, force: true }));

    const delegate = async (params: Record<string, unknown>) => {
      const reg = await loadPlugins({
        dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot,
        logger: { info() {}, warn() {}, error() {} },
      });
      const platform = reg.platforms.find((p) => p.name === 'subagent');
      if (!platform) throw new Error('subagent platform not registered');
      platform.listen(async (_src, _task, onEvent) => {
        onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-sub-name' });
        return 'done';
      });
      const tool = reg.tools.find((t) => t.name === 'Delegate');
      if (!tool) throw new Error('Delegate tool not registered');
      const executor = tool as unknown as { execute: (id: string, p: unknown) => Promise<unknown> };
      await runWithPolicy(
        adminPolicy,
        () => executor.execute('call-1', params),
        { identity: owner, sessionId: 'brain-1', emitSubagent: (u) => updates.push(u) },
      );
      return updates;
    };

    it('accepts an explicit `name` and carries it on every progress update', async () => {
      const seen = await delegate({ task: 'Audit the migration for safety', name: 'migration-review' });

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((u) => u.name === 'migration-review')).toBe(true);
    });

    it('derives a name when the parent omitted one, so no row is left unlabelled', async () => {
      const seen = await delegate({ task: 'Audit the migration for safety and report back' });

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((u) => u.name === 'Audit the migration for safety')).toBe(true);
    });
  });

  describe('the tool schema', () => {
    let dataRoot: string;

    beforeEach(() => { dataRoot = mkdtempSync(join(tmpdir(), 'subagent-name-schema-')); });
    afterEach(() => rmSync(dataRoot, { recursive: true, force: true }));

    it('advertises `name` as an optional string a parent may pass to Delegate', async () => {
      const reg = await loadPlugins({
        dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot,
        logger: { info() {}, warn() {}, error() {} },
      });
      const tool = reg.tools.find((t) => t.name === 'Delegate') as unknown as {
        parameters: { properties: Record<string, { type?: string; description?: string }>; required?: string[] };
      };

      expect(tool.parameters.properties.name?.type).toBe('string');
      expect(tool.parameters.properties.name?.description).toBeTruthy();
      expect(tool.parameters.required ?? []).not.toContain('name');
    });
  });
});
