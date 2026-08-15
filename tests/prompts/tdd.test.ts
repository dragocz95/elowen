import { describe, it, expect } from 'vitest';
import { tddDirective, TDD_DIRECTIVE } from '../../src/prompts/tdd.js';
import { rawTemplate } from '../../src/prompts/index.js';
import { EDITABLE_PROMPTS } from '../../src/prompts/catalog.js';

describe('tddDirective', () => {
  it('returns the directive prefixed with a blank-line gap when on', () => {
    const out = tddDirective(true);
    expect(out.startsWith('\n\n')).toBe(true);
    expect(out).toContain(TDD_DIRECTIVE);
    expect(out).toContain('Test-Driven Development');
  });
  it('returns an empty string when off (append is a no-op)', () => {
    expect(tddDirective(false)).toBe('');
  });
});

describe('TDD directive is injected at the append seam, not through a template placeholder', () => {
  // The directive rides on a code-side append, NOT a {{tddDirective}} placeholder. That is the whole
  // point: a user's saved wholesale override omits the placeholder, so riding on it would silently drop
  // the directive when TDD mode is on. The daemon's own seam is brainWorker over `worker-brain`; that
  // append — including the stale-override case — is exercised in tests/brain/worker/brainWorker.test.ts.
  // The CLI-agent seam (buildAgentCommand over the worker* templates) belongs to the agents plugin and
  // is covered by that plugin's own suite in the plugin registry.

  it('worker-brain: the shipped template carries no {{tddDirective}} placeholder', () => {
    expect(rawTemplate('worker-brain')).not.toContain('{{tddDirective}}');
  });

  it('no daemon-owned editable template bakes the directive text in', () => {
    // The directive lives ONLY in the code-side append; no .md ships it. This guards against anyone
    // re-inlining it into a template (which an override would then be able to break again).
    for (const p of EDITABLE_PROMPTS) {
      expect(rawTemplate(p.name)).not.toContain('Test-Driven Development');
    }
  });
});
