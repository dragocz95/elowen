import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectSessionId } from '../../../../plugins/agents/src/usage/sessionId.js';
import type { AgentSpec } from '../../../../src/shared/execRouting.js';

const fallback: AgentSpec = { program: 'claude-code', model: 'sonnet' };
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'elowen-sessid-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const at = (ms: number) => new Date(ms).toISOString();

describe('detectSessionId', () => {
  it('returns the claude session uuid (the transcript filename) for a claude task', () => {
    const start = Date.parse('2026-02-01T00:00:00.000Z');
    const projDir = join(home, '.claude', 'projects', '-p');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, '7f3a-uuid.jsonl'), JSON.stringify({ timestamp: at(start) }) + '\n');

    const task = { id: 't1', created_at: '', labels: ['exec:sonnet', `started:${start}`] };
    expect(detectSessionId(task, [], '/p', fallback, home)).toEqual({ program: 'claude-code', sessionId: '7f3a-uuid' });
  });

  it('extracts the codex session uuid from the rollout filename for a codex task', () => {
    const start = Date.parse('2026-02-01T07:53:43.000Z');
    const dir = join(home, '.codex', 'sessions', '2026', '02', '01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rollout-2026-02-01T07-53-43-cx9-uuid.jsonl'), JSON.stringify({ timestamp: at(start) }) + '\n');

    const task = { id: 't1', created_at: '', labels: ['exec:codex:gpt-5.5', `started:${start}`] };
    expect(detectSessionId(task, [], '/p', fallback, home)).toEqual({ program: 'codex', sessionId: 'cx9-uuid' });
  });

  it('returns null when no session storage exists (cold start fallback)', () => {
    const task = { id: 't1', created_at: '', labels: ['exec:sonnet', `started:${Date.now()}`] };
    expect(detectSessionId(task, [], '/p', fallback, home)).toBeNull();
  });
});
