import { describe, it, expect } from 'vitest';
import { repairJson, parseLenient } from '../../../../src/api/services/jsonRepair.js';
import { extractJson } from '../../../../src/api/services/llmParse.js';
import { parseDecision } from '../../../../plugins/agents/src/overseer/decision.js';
import { parsePhases } from '../../../../src/api/services/planner.js';

describe('repairJson + parseLenient', () => {
  it('removes trailing commas before } and ]', () => {
    expect(parseLenient('{"a":1,}')).toEqual({ a: 1 });
    expect(parseLenient('[1,2,3,]')).toEqual([1, 2, 3]);
    expect(parseLenient('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });

  it('converts single-quoted strings to double-quoted', () => {
    expect(parseLenient("{'a':'b'}")).toEqual({ a: 'b' });
  });

  it('quotes bare identifier keys', () => {
    expect(parseLenient('{approve:true, confidence:0.9}')).toEqual({ approve: true, confidence: 0.9 });
  });

  it('strips // and /* */ comments outside strings', () => {
    expect(parseLenient('{\n  "a": 1, // note\n  "b": 2\n}')).toEqual({ a: 1, b: 2 });
    expect(parseLenient('{ "a": 1 /* inline */ }')).toEqual({ a: 1 });
  });

  it('normalizes smart/curly quotes', () => {
    expect(parseLenient('{“a”:“b”}')).toEqual({ a: 'b' });
  });

  it('preserves apostrophes and // inside double-quoted strings', () => {
    expect(parseLenient('{"msg":"don\'t go to http://x"}')).toEqual({ msg: "don't go to http://x" });
  });

  it('is idempotent on already-valid JSON', () => {
    const valid = '{"a":1,"b":["x","y"],"c":{"d":true}}';
    expect(repairJson(valid)).toBe(valid);
    expect(parseLenient(valid)).toEqual({ a: 1, b: ['x', 'y'], c: { d: true } });
  });

  it('throws the original error when the snippet is not JSON even after repair', () => {
    expect(() => parseLenient('not json at all')).toThrow();
  });

  // Review regressions: structural fixes must NEVER touch content inside (originally single-quoted)
  // strings — quotes are normalized to double FIRST so every later pass sees correct string boundaries.
  it('preserves // and block-comment-like text inside single-quoted values', () => {
    expect(parseLenient("{'choice':'a','rationale':'see src // note'}")).toEqual({ choice: 'a', rationale: 'see src // note' });
    expect(parseLenient("{a: 'a /* b */ c'}")).toEqual({ a: 'a /* b */ c' });
  });

  it('does not quote bare-key-like patterns that live inside a string value', () => {
    expect(parseLenient('{"a": "see {x: 1}", "b": 2,}')).toEqual({ a: 'see {x: 1}', b: 2 });
  });

  // A single-quoted string carries its own escapes, and re-quoting has to translate them rather than
  // layer another round on top. Both of these are ordinary model output — an apostrophe is about the
  // most common character a written sentence has — and both used to come back out unparseable.
  it('unwraps an escaped apostrophe, which JSON has no escape for', () => {
    expect(parseLenient(String.raw`{'msg': 'don\'t'}`)).toEqual({ msg: "don't" });
  });

  it('does not escape a quote that the single-quoted body had already escaped', () => {
    // `\"` escaped a second time becomes `\\"` — an escaped backslash and then a LIVE quote, which ends
    // the string early and turns a repairable snippet into a parse error.
    expect(parseLenient(String.raw`{'msg': 'say \" hi'}`)).toEqual({ msg: 'say " hi' });
  });

  it('escapes a raw quote inside a single-quoted value and leaves other escapes alone', () => {
    expect(parseLenient(`{'a': 'he said "hi"'}`)).toEqual({ a: 'he said "hi"' });
    expect(parseLenient(String.raw`{'a': 'line\nbreak'}`)).toEqual({ a: 'line\nbreak' });
    expect(parseLenient(String.raw`{'a': 'x\\'}`)).toEqual({ a: 'x\\' });
  });

  it('handles single-quoted values containing braces', () => {
    expect(parseLenient("{'a': 'x } y', 'b': 1}")).toEqual({ a: 'x } y', b: 1 });
  });
});

describe('extractJson uses lenient parsing', () => {
  it('parses a fenced object with a trailing comma and bare keys', () => {
    const out = 'Here is the verdict:\n```json\n{approve: true, confidence: 0.9, rationale: \'looks safe\',}\n```';
    expect(extractJson(out, '{')).toEqual({ approve: true, confidence: 0.9, rationale: 'looks safe' });
  });
});

describe('downstream parsers survive off-contract JSON', () => {
  it('parseDecision handles trailing comma + single quotes', () => {
    const d = parseDecision("{approve:true, confidence:0.9, rationale:'ok',}");
    expect(d).toEqual({ approve: true, confidence: 0.9, rationale: 'ok' });
  });

  it('parsePhases handles a trailing comma in the array', () => {
    const phases = parsePhases('[{"title":"A","type":"task","details":"do a"},]');
    expect(phases).toHaveLength(1);
    expect(phases[0].title).toBe('A');
  });
});
