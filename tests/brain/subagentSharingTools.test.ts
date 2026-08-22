import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { composeSessionTools } from '../../src/brain/session/capabilities.js';
import { isSubagentSession } from '../../src/brain/sessionId.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** ShareFile/ShareImage exist to hand something to a PERSON. A sub-agent has nobody on the other end —
 *  what it shares lands in its own panel, never in the conversation that delegated the work — so the
 *  tools are withheld from delegated sessions entirely.
 *
 *  That also removes a capability rather than merely refusing it: a delegated child can hold all-access
 *  (scope.admin) while a narrow `tools` allow-list keeps Read out of its set, because an allow-list
 *  narrows only PLUGIN tools and these two are built-ins. Such a child could otherwise publish any file
 *  on the host despite being handed a deliberately minimal toolset. */
const SHARING = ['ShareImage', 'ShareFile'];
const fake = (name: string): ToolDefinition => ({ name, description: name, execute: async () => ({ content: [] }) } as unknown as ToolDefinition);
const names = (share: boolean): string[] =>
  composeSessionTools({
    kind: 'trusted-channel', // what a delegated child with an admin scope resolves to
    pluginTools: [fake('Grep')],
    ...(share ? { shareImage: () => [fake('ShareImage'), fake('ShareFile')] } : {}),
  }).map((t) => t.name);

describe('sharing tools are for a human-facing session, not a sub-agent', () => {
  it('composes them when the caller supplies them, and not otherwise', () => {
    expect(names(true)).toEqual(expect.arrayContaining(SHARING));
    for (const n of SHARING) expect(names(false)).not.toContain(n);
    // The narrow toolset the child was actually given is untouched either way.
    expect(names(false)).toContain('Grep');
  });

  // The decision itself lives in the spawner, which is the only place that knows the session id. Pin it
  // against the source: a plain composition test cannot see that wiring, and losing it would silently
  // hand every delegated child the sharing tools back.
  it('the spawner withholds them for a delegated session', () => {
    const src = readFileSync(new URL('../../src/brain/service/spawner.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/shareImage:\s*isSubagentSession\(sessionId\)\s*\?\s*undefined\s*:/);
  });

  it('recognises the delegated session id shape the guard depends on', () => {
    expect(isSubagentSession('brain-ch-subagent-sub-dlg-abc')).toBe(true);
    expect(isSubagentSession('brain-ch-msteams-19:meeting')).toBe(false);
    expect(isSubagentSession('brain-1')).toBe(false);
  });
});
