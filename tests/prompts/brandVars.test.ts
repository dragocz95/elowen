import { describe, it, expect } from 'vitest';
import { render } from '../../src/prompts/index.js';

const defaults = { userName: 'Filip', personality: '', agentName: 'Elowen', productName: 'Elowen' };

// GOLDEN GUARANTEE: with no theme active the resolver yields productName 'Elowen', and substituting it
// must brand every place the prose names the product. This is NOT a byte-stability pin on the wording —
// editing the prompt is expected and invalidates existing prompt caches by design. What must never break
// is that a rebrand reaches every occurrence and leaves no placeholder or hardcoded name behind.
describe('advisor prompts with the built-in brand', () => {
  it('renders the Elowen brand throughout and leaves no {{productName}} behind', () => {
    const out = render('elowen', defaults);
    expect(out).toContain('inside their Elowen workspace');
    expect(out).toContain("the user's Elowen advisor");
    expect(out).toContain('You act through Elowen with the active user');
    expect(out).not.toContain('{{productName}}');
    // Interface identifiers are an API contract, not brand — they must stay literal even under a theme.
    // (Not a tool name: a core template must not name a tool a plugin owns, see corePromptToolPromises.)
    expect(out).toContain('`ELOWEN_TOKEN`');
  });

  it('platform overlay substitutes cleanly too', () => {
    const overlay = render('elowen-platform', { ownerName: 'Filip', agentName: 'Elowen', productName: 'Elowen' });
    expect(overlay).toContain('who operates this Elowen instance');
    expect(overlay).not.toContain('{{productName}}');
  });

  it('a themed productName rebrands the prose while tool names stay literal', () => {
    const out = render('elowen', { ...defaults, agentName: 'Acme Bot', productName: 'Acme' });
    expect(out).toContain('inside their Acme workspace');
    expect(out).toContain('You are Acme Bot,');
    expect(out).toContain('`ELOWEN_TOKEN`');
    expect(out).toContain('`elowen api METHOD PATH [jsonBody]`');
    expect(out).not.toContain('Elowen workspace');
  });
});
