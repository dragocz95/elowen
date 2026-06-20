import { describe, it, expect } from 'vitest';
import { detectAgentPrompt } from '../../src/deriver/shellPatterns.js';

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
});
