import { describe, it, expect } from 'vitest';
import { detectAgentPrompt } from '../../src/deriver/shellPatterns.js';

const OC_DIALOG = `  ┃  △ Permission required
  ┃   Allow once   Allow always   Reject       ctrl+f fullscreen  ⇆ select  enter confirm`;

describe('detectAgentPrompt', () => {
  it('detects the OpenCode permission dialog and marks it auto-approvable with Enter', () => {
    const p = detectAgentPrompt(OC_DIALOG, 'opencode');
    expect(p).not.toBeNull();
    expect(p!.autoApprove).toEqual({ keys: ['Enter'] });
  });
  it('returns null for ordinary opencode output', () => {
    expect(detectAgentPrompt('Build · deepseek-v4-flash  28.8K (3%)', 'opencode')).toBeNull();
  });
  it('returns null for non-opencode programs', () => {
    expect(detectAgentPrompt(OC_DIALOG, 'claude-code')).toBeNull();
  });
});
