import { describe, it, expect } from 'vitest';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { withReason, stripReason, extractReason, isReasonExcluded, REASON_DESC } from '../../src/brain/toolReason.js';

/** A minimal object-schema tool whose execute records the params it actually received. */
function sampleTool(name: string, calls: unknown[] = []): ToolDefinition {
  return defineTool({
    name,
    description: 'x',
    parameters: Type.Object({ path: Type.String(), count: Type.Optional(Type.Number()) }),
    execute: async (_id: string, params: unknown) => { calls.push(params); return { content: [], details: {} }; },
  }) as unknown as ToolDefinition;
}

const props = (tool: ToolDefinition): Record<string, unknown> =>
  (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};

describe('toolReason.withReason', () => {
  it('prepends an optional _reason property to an object-schema tool, keeping the originals and required set', () => {
    const augmented = withReason(sampleTool('Write'));
    const p = props(augmented);
    expect(Object.keys(p)[0]).toBe('_reason');           // first in schema order → schema-following models author it first
    expect(p._reason).toMatchObject({ description: REASON_DESC });
    expect(p.path).toBeDefined();
    expect(p.count).toBeDefined();
    // path stays required, _reason/count optional.
    const required = (augmented.parameters as { required?: string[] }).required ?? [];
    expect(required).toContain('path');
    expect(required).not.toContain('_reason');
  });

  // Kimi K3 emits tool-call JSON keys in byte order regardless of schema order — a key named `reason`
  // landed AFTER a Write's whole content, so the live spinner note arrived only as the call finished.
  // `_` (0x5F) sorts before every lowercase letter, keeping the note first even for byte-sorting models.
  it('names the property so it byte-sorts before ordinary lowercase argument keys', () => {
    const p = props(withReason(sampleTool('Write')));
    const injected = Object.keys(p)[0]!;
    for (const other of Object.keys(p).slice(1)) {
      expect(injected < other).toBe(true);
    }
  });

  it('leaves excluded tools (ToolSearch, Bash, mcp__*) and non-object schemas untouched', () => {
    expect(props(withReason(sampleTool('ToolSearch')))._reason).toBeUndefined();
    expect(props(withReason(sampleTool('Bash')))._reason).toBeUndefined();
    expect(props(withReason(sampleTool('mcp__chrome__navigate')))._reason).toBeUndefined();
    const scalar = { name: 'Weird', parameters: Type.String() } as unknown as ToolDefinition;
    expect(withReason(scalar)).toBe(scalar);
  });
});

describe('toolReason.isReasonExcluded', () => {
  it('excludes ToolSearch, Bash, and any mcp__ tool, includes everything else', () => {
    expect(isReasonExcluded('ToolSearch')).toBe(true);
    expect(isReasonExcluded('mcp__server__tool')).toBe(true);
    expect(isReasonExcluded('Bash')).toBe(true);
    expect(isReasonExcluded('ElowenListTasks')).toBe(false);
  });
});

describe('toolReason.stripReason', () => {
  it('removes _reason from the arguments before the real handler runs, without mutating the caller object', () => {
    const calls: unknown[] = [];
    const wrapped = stripReason(sampleTool('Write', calls));
    const args = { _reason: 'Píšu soubor', path: 'a.ts', count: 2 };
    return wrapped.execute!('call-1', args as never, {} as never).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ path: 'a.ts', count: 2 }); // note gone
      expect(args).toHaveProperty('_reason');                // caller's object untouched (cloned, not mutated)
    });
  });

  it('also strips the legacy reason key (pre-rename session, or a model copying its history)', () => {
    const calls: unknown[] = [];
    const wrapped = stripReason(sampleTool('Write', calls));
    return wrapped.execute!('call-legacy', { reason: 'Píšu soubor', path: 'a.ts' } as never, {} as never).then(() => {
      expect(calls[0]).toEqual({ path: 'a.ts' });
    });
  });

  it('passes arguments through untouched when no note is present', () => {
    const calls: unknown[] = [];
    const wrapped = stripReason(sampleTool('Write', calls));
    return wrapped.execute!('call-2', { path: 'b.ts' } as never, {} as never).then(() => {
      expect(calls[0]).toEqual({ path: 'b.ts' });
    });
  });
});

describe('toolReason.extractReason JSON-escaped notes', () => {
  // Observed live: claude-opus-5 wrote the note as JSON text a second time, so every accented character
  // reached the spinner as a literal `\u00e1` run while the SAME call's other arguments kept their
  // diacritics. The note is a display string, so it is decoded where it is read.
  it('decodes a note whose non-ASCII characters arrived as literal \\uXXXX escapes', () => {
    expect(extractReason({ _reason: 'Zad\\u00e1v\\u00e1m obnovu konverzac\\u00ed…', id: 'dlg-1' }))
      .toBe('Zadávám obnovu konverzací…');
    expect(extractReason({ reason: 'Zad\\u00e1v\\u00e1m…' })).toBe('Zadávám…'); // legacy key decodes too
  });

  it('rebuilds a surrogate pair instead of two replacement characters, and decodes the other escapes', () => {
    expect(extractReason({ _reason: 'Nasazuji \\ud83d\\ude80 \\u2026' })).toBe('Nasazuji 🚀 …');
    expect(extractReason({ _reason: 'P\\u00ed\\u0161u \\"a.ts\\" a b\\\\c\\u2026' })).toBe('Píšu "a.ts" a b\\c…');
  });

  it('drops a tail the stream has not finished — a half-written escape or a split surrogate pair', () => {
    expect(extractReason({ _reason: 'Zad\\u00e1v\\u00e1m obnovu\\u00' })).toBe('Zadávám obnovu');
    expect(extractReason({ _reason: 'Zad\\u00e1v\\u00e1m\\' })).toBe('Zadávám');
    expect(extractReason({ _reason: 'Nasazuji \\u2026\\ud83d' })).toBe('Nasazuji …');
  });

  it('leaves a note without a complete escape run exactly as authored', () => {
    expect(extractReason({ _reason: 'Zadávám obnovu konverzací…' })).toBe('Zadávám obnovu konverzací…');
    expect(extractReason({ _reason: 'Čtu C:\\temp\\file…' })).toBe('Čtu C:\\temp\\file…'); // no \t → tab
    // A raw quote cannot close into a string literal; the note stays verbatim rather than being dropped.
    expect(extractReason({ _reason: 'P\\u00ed\\u0161u "a.ts"…' })).toBe('P\\u00ed\\u0161u "a.ts"…');
  });
});

describe('toolReason.extractReason', () => {
  it('returns a non-empty string note, else undefined', () => {
    expect(extractReason({ _reason: 'Čtu konfiguraci', path: 'x' })).toBe('Čtu konfiguraci');
    expect(extractReason({ reason: 'Čtu konfiguraci' })).toBe('Čtu konfiguraci'); // legacy key still honored
    expect(extractReason({ description: 'Run focused tests' }, 'Bash')).toBe('Run focused tests');
    expect(extractReason({ description: 'Run focused tests' }, 'Write')).toBeUndefined();
    expect(extractReason({ _reason: '   ' })).toBeUndefined();
    expect(extractReason({ path: 'x' })).toBeUndefined();
    expect(extractReason({ _reason: 42 })).toBeUndefined();
    expect(extractReason(null)).toBeUndefined();
    expect(extractReason('nope')).toBeUndefined();
  });
});
