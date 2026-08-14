import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripInlineReasoning } from '../../src/brain/messageView.js';

// Inline chain-of-thought stripping is hand-mirrored because the untyped `.mjs` plugin shared library
// cannot import the daemon's NodeNext source: src/brain/messageView.ts serves every stored-message
// consumer, packages/plugin-shared/format.mjs serves each adapter's text-fallback path. The same text must not
// come out differently depending on which one saw it, and until this test existed nothing said so.
//
// The corpus deliberately leads with the case that made the pair worth guarding: BOTH copies used to
// delete from an unclosed opening tag to end-of-string with no anchoring, so ordinary prose that merely
// MENTIONED a reasoning tag lost everything after the mention. A 12 000-character report discussing this
// very function was silently delivered as 2 936 characters. Anchoring both open-ended rules to a line
// boundary keeps every genuine case (a cut-off stream opens its reasoning on a fresh line) while leaving
// a mid-sentence mention alone.
//
// This lock works by reading the shared source from disk, so it holds only while elowen-plugin-shared
// is built from this repository. If that package is ever developed elsewhere, the guard has to become
// something the package itself carries (a published fixture both sides assert against) — otherwise it
// keeps passing against a copy nobody ships.
const pluginPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/plugin-shared/format.mjs');
const plugin = await import(pluginPath) as { stripThinking(text: string): string };

const CORPUS: { label: string; input: string }[] = [
  // The regression: a mention inside prose must survive whole.
  { label: 'mid-sentence mention keeps the tail', input: 'Finding 3: the `<think>` tag is deleted here.\n\nAnd this line must survive.' },
  { label: 'mention with no code fence', input: 'A reply containing <think> in prose still keeps its ending.' },
  { label: 'mention of a close tag keeps the head', input: 'The stripper removes </think> tags from the text.' },
  { label: 'both tags named in one sentence', input: 'It matches <think> and </think> alike, and then continues.' },
  // Genuine reasoning that must still be removed.
  { label: 'complete block', input: '<think>let me reason\nabout this</think>\n\nThe answer is 42.' },
  { label: 'complete thinking block', input: '<thinking>hmm</thinking>Hello' },
  { label: 'two complete blocks', input: '<think>a</think>one<think>b</think>two' },
  { label: 'unclosed trailing block from the start', input: '<think>still reasoning and never closed' },
  { label: 'unclosed block opening on its own line', input: 'Partial answer.\n<think>reasoning that got cut off' },
  { label: 'leading close tag', input: 'reasoning with no open tag</think>\n\nFinal answer.' },
  { label: 'reasoning only', input: '<think>only reasoning</think>' },
  { label: 'attributes on the open tag', input: '<think type="x">reasoning</think>answer' },
  { label: 'uppercase tag', input: '<THINK>reasoning</THINK>answer' },
  // Text the stripper must not touch at all.
  { label: 'no tags', input: 'A perfectly ordinary reply.' },
  { label: 'empty', input: '' },
  { label: 'unrelated angle brackets', input: 'Compare a < b and c > d, then think about it.' },
];

describe('inline reasoning stripping parity (daemon ⋅ plugin shared)', () => {
  for (const { label, input } of CORPUS) {
    it(`agrees on: ${label}`, () => {
      expect(plugin.stripThinking(input)).toBe(stripInlineReasoning(input));
    });
  }

  // The parity assertions above would also pass if BOTH copies regressed together, so the behaviour that
  // motivated the pair is pinned outright rather than only compared.
  it('never truncates prose that merely mentions a reasoning tag', () => {
    const text = 'Finding 3: the `<think>` tag is deleted here.\n\nAnd this line must survive.';
    expect(stripInlineReasoning(text)).toContain('And this line must survive.');
    expect(plugin.stripThinking(text)).toContain('And this line must survive.');
  });

  it('never truncates prose that mentions a closing tag', () => {
    const text = 'The stripper removes </think> tags from the text.';
    expect(stripInlineReasoning(text)).toBe(text);
    expect(plugin.stripThinking(text)).toBe(text);
  });

  it('still removes reasoning a model really emitted', () => {
    expect(stripInlineReasoning('<think>secret</think>visible')).toBe('visible');
    expect(plugin.stripThinking('<think>secret</think>visible')).toBe('visible');
    expect(stripInlineReasoning('<think>cut off mid-thought')).toBe('');
    expect(plugin.stripThinking('<think>cut off mid-thought')).toBe('');
  });
});
