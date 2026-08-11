import { describe, it, expect } from 'vitest';
import { render } from '../../src/prompts/index.js';

const defaults = { userName: 'Filip', personality: '', agentName: 'Elowen', productName: 'Elowen' };

// GOLDEN GUARANTEE: with no theme active the resolver yields productName 'Elowen', and substituting it
// must reproduce the exact pre-white-label prose — the system-prompt prefix of every EXISTING install
// must stay byte-stable or their prompt caches all invalidate on upgrade.
describe('advisor prompts with the built-in brand', () => {
  it('renders the historical Elowen prose and leaves no {{productName}} behind', () => {
    const out = render('elowen', defaults);
    expect(out).toContain('inside their Elowen workspace');
    expect(out).toContain("the user's Elowen advisor");
    expect(out).toContain('You act through Elowen with the current user');
    expect(out).not.toContain('{{productName}}');
    // Tool names are an API contract, not brand — they must stay literal even under a theme.
    expect(out).toContain('`ElowenListTasks` lists tasks.');
  });

  it('platform overlay substitutes cleanly too', () => {
    const overlay = render('elowen-platform', { ownerName: 'Filip', agentName: 'Elowen', productName: 'Elowen' });
    expect(overlay).toContain('who operates this Elowen instance');
    expect(overlay).not.toContain('{{productName}}');
  });

  it('a themed productName rebrands the prose while tool names stay literal', () => {
    const out = render('elowen', { ...defaults, agentName: 'Acme Bot', productName: 'Acme' });
    expect(out).toContain('inside their Acme workspace');
    expect(out).toContain('<name>Acme Bot</name>');
    expect(out).toContain('`ElowenListTasks` lists tasks.');
    expect(out).not.toContain('Elowen workspace');
  });
});
