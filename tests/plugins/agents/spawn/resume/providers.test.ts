import { describe, it, expect } from 'vitest';
import { parseResumeLabel, resumeProviderFor } from '../../../../../src/shared/resume/index.js';
import { claudeResume } from '../../../../../src/shared/resume/claude.js';
import { codexResume } from '../../../../../src/shared/resume/codex.js';
import { opencodeResume } from '../../../../../src/shared/resume/opencode.js';
import { kiloResume } from '../../../../../src/shared/resume/kilo.js';
import { piResume } from '../../../../../src/shared/resume/pi.js';
import { ompResume } from '../../../../../src/shared/resume/omp.js';

describe('resume providers', () => {
  it('claude resumes via the --resume flag, alongside --model', () => {
    expect(claudeResume.resumeArgs('abc-123')).toEqual({ args: ['--resume', 'abc-123'], placement: 'flag' });
  });
  it('codex resumes via the `resume` subcommand, before the flags', () => {
    expect(codexResume.resumeArgs('abc-123')).toEqual({ args: ['resume', 'abc-123'], placement: 'subcommand' });
  });
  it('opencode resumes via the -s session flag', () => {
    expect(opencodeResume.resumeArgs('ses_9')).toEqual({ args: ['-s', 'ses_9'], placement: 'flag' });
  });
  it('kilo resumes via the --session flag', () => {
    expect(kiloResume.resumeArgs('k-9')).toEqual({ args: ['--session', 'k-9'], placement: 'flag' });
  });
  it('pi resumes via the --session flag', () => {
    expect(piResume.resumeArgs('p-9')).toEqual({ args: ['--session', 'p-9'], placement: 'flag' });
  });
  it('omp resumes via the --resume flag', () => {
    expect(ompResume.resumeArgs('o-9')).toEqual({ args: ['--resume', 'o-9'], placement: 'flag' });
  });
});

describe('resumeProviderFor', () => {
  it('maps each program id to its strategy, normalizing opencode variants', () => {
    expect(resumeProviderFor('claude-code')).toBe(claudeResume);
    expect(resumeProviderFor('codex')).toBe(codexResume);
    expect(resumeProviderFor('opencode')).toBe(opencodeResume);
    expect(resumeProviderFor('opencode-zen')).toBe(opencodeResume); // 'opencode…' normalizes
    expect(resumeProviderFor('kilo')).toBe(kiloResume);
    expect(resumeProviderFor('pi')).toBe(piResume);
    expect(resumeProviderFor('omp')).toBe(ompResume);
    expect(resumeProviderFor('mystery')).toBeUndefined();
  });
});

describe('parseResumeLabel', () => {
  it('parses a well-formed resume label', () => {
    expect(parseResumeLabel(['exec:sonnet', 'resume:claude-code:7f3a-uuid'])).toEqual({ program: 'claude-code', sessionId: '7f3a-uuid' });
  });
  it('keeps an opencode session id intact (the `ses_` handle has no inner colon)', () => {
    expect(parseResumeLabel(['resume:opencode:ses_10037'])).toEqual({ program: 'opencode', sessionId: 'ses_10037' });
  });
  it('returns undefined when there is no resume label', () => {
    expect(parseResumeLabel(['exec:sonnet', 'agent:Nova'])).toBeUndefined();
  });
  it('rejects an unknown program (so a stale label can never resume a gone provider)', () => {
    expect(parseResumeLabel(['resume:ollama:xyz'])).toBeUndefined();
  });
  it('rejects a malformed label (missing session id)', () => {
    expect(parseResumeLabel(['resume:claude-code:'])).toBeUndefined();
    expect(parseResumeLabel(['resume:claude-code'])).toBeUndefined();
  });
});
