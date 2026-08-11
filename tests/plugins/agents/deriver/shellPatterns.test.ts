import { describe, it, expect } from 'vitest';
import { detectAgentPrompt } from '../../../../plugins/agents/src/deriver/shellPatterns/index.js';

const OC_DIALOG = `  ┃  △ Permission required
  ┃   Allow once   Allow always   Reject       ctrl+f fullscreen  ⇆ select  enter confirm`;

describe('detectAgentPrompt', () => {
  it('detects the OpenCode permission dialog and marks Enter as the accept key', () => {
    const p = detectAgentPrompt(OC_DIALOG, 'opencode');
    expect(p).not.toBeNull();
    expect(p!.acceptKeys).toEqual(['Enter']);
  });
  it('detects the Claude workspace-trust gate and marks it auto-accept', () => {
    const dialog = ` Accessing workspace:\n /tmp/new-project\n Quick safety check: Is this a project you created or one you trust?\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n Enter to confirm · Esc to cancel`;
    const p = detectAgentPrompt(dialog, 'claude-code');
    expect(p).not.toBeNull();
    expect(p!.acceptKeys).toEqual(['Enter']);
    expect(p!.autoAccept).toBe(true);
  });
  it('detects the Claude "Do you want to proceed?" gate', () => {
    const p = detectAgentPrompt('Edit file?\n  Do you want to proceed?\n ❯ 1. Yes\n   2. No', 'claude-code');
    expect(p).not.toBeNull();
    expect(p!.acceptKeys).toEqual(['Enter']);
  });
  it('detects a Codex approval gate', () => {
    const p = detectAgentPrompt('Allow command? rm -rf build', 'codex');
    expect(p).not.toBeNull();
    expect(p!.acceptKeys).toEqual(['Enter']);
  });
  it('returns null for ordinary opencode output', () => {
    expect(detectAgentPrompt('Build · deepseek-v4-flash  28.8K (3%)', 'opencode')).toBeNull();
  });

  // OpenCode "ask the user" list UI (the agent's `question` tool). Distinct from the permission
  // dialog: its footer reads "enter submit … esc dismiss". The fixture embeds an incidental "4. Run
  // the web app" line in scrollback above the list to prove the parser only takes the contiguous
  // 1..N run directly above the footer.
  const OC_QUESTION = `  ┃  web/deploy/elowen-nginx.conf.example:12:#   4. Run the web app on :4500
  ┃
  ┃  # Questions
  ┃
  ┃  Rozpor v portu web UI: which port is canonical?
  ┃
  ┃  1. :4500 (uprav package.json)                                          ~/elowen:main
  ┃     Změnit web/package.json start na next start -p 4500.
  ┃  2. :4500 (uprav README + WEB.md)
  ┃     Ponechat package.json, sjednotit docs.
  ┃  3. :3000 (uprav docs na 3000)
  ┃     Přijmout default Next.js port.
  ┃  4. Type your own answer
  ┃  ↑↓ select  enter submit  esc dismiss`;

  it('detects the OpenCode question list and parses the canned options (id = list position)', () => {
    const p = detectAgentPrompt(OC_QUESTION, 'opencode');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('choice');
    expect(p!.question).toMatch(/which port is canonical\?/);
    // "Type your own answer" is dropped — the overseer picks among canned options; a freeform
    // answer is a human's to write (it escalates instead).
    expect(p!.options).toEqual([
      { id: '1', label: ':4500 (uprav package.json)' },
      { id: '2', label: ':4500 (uprav README + WEB.md)' },
      { id: '3', label: ':3000 (uprav docs na 3000)' },
    ]);
    expect(p!.acceptKeys).toEqual(['Enter']);
  });

  it('a permission dialog stays kind=permission (not a choice)', () => {
    const p = detectAgentPrompt(OC_DIALOG, 'opencode');
    expect(p!.kind ?? 'permission').toBe('permission');
  });

  // Claude Code's AskUserQuestion UI — a DIFFERENT shape from OpenCode's: a "❯" focus cursor, a "☐"
  // title, and the footer "Enter to select · ↑/↓ to navigate · Esc to cancel". Claude always appends
  // "Type something." and "Chat about this" escape hatches, which must be dropped.
  const CLAUDE_QUESTION = ` ☐ Port consistency
The README and nginx both use port 4500, but package.json uses 3000. What should we do?
❯ 1. Update README and WEB.md
   Update README and WEB.md to document next start -p 4500
  2. Delete the nginx config
   Remove the nginx configuration file entirely
  3. Remove all port numbers from docs
   Strip all port references from documentation
  4. Type something.
─────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`;

  it('detects the Claude AskUserQuestion list and drops the "Type something"/"Chat about this" hatches', () => {
    const p = detectAgentPrompt(CLAUDE_QUESTION, 'claude-code');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('choice');
    expect(p!.question).toMatch(/What should we do\?/);
    expect(p!.options).toEqual([
      { id: '1', label: 'Update README and WEB.md' },
      { id: '2', label: 'Delete the nginx config' },
      { id: '3', label: 'Remove all port numbers from docs' },
    ]);
    expect(p!.acceptKeys).toEqual(['Enter']);
  });

  it('does not confuse the Claude question footer with OpenCode (provider-scoped)', () => {
    // The same text under the opencode program must NOT match (opencode wants "enter submit").
    expect(detectAgentPrompt(CLAUDE_QUESTION, 'opencode')).toBeNull();
  });

  // A footer is on screen (agent IS blocked) but the numbered run is broken (starts at 2, no "1.").
  // We must bail to null rather than mis-navigate a guessed list — better a human escalation than the
  // wrong key presses. (The parser also warns on this path so the miss is never silent.)
  it('returns null when the footer matches but the option run is not a clean 1..N', () => {
    const broken = `  ┃  Which port is canonical?
  ┃  2. :4500 (uprav package.json)
  ┃  3. :3000 (uprav docs)
  ┃  ↑↓ select  enter submit  esc dismiss`;
    expect(detectAgentPrompt(broken, 'opencode')).toBeNull();
  });
});
