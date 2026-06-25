import { describe, it, expect } from 'vitest';
import { allModels, isPresetExec, removeModel, upsertModel, type ModelState } from '../../lib/execPresets';

// A preset exec that really exists in EXEC_PRESETS, used across the cases below.
const PRESET = 'ollama-cloud/deepseek-v4-pro';

describe('isPresetExec', () => {
  it('recognises built-in presets and rejects unknown execs', () => {
    expect(isPresetExec(PRESET)).toBe(true);
    expect(isPresetExec('my/custom-model')).toBe(false);
  });
});

describe('removeModel', () => {
  it('hides a plain preset and drops it from the allowlist', () => {
    const s: ModelState = { allowed: [PRESET, 'sonnet'], customModels: [], hiddenPresets: [], modelNotes: {} };
    const next = removeModel(s, PRESET);
    expect(next.hiddenPresets).toContain(PRESET);
    expect(next.allowed).not.toContain(PRESET);
    // …and it no longer appears in the merged list.
    expect(allModels(next.customModels, next.hiddenPresets).some((m) => m.exec === PRESET)).toBe(false);
  });

  it('fully removes a custom OVERRIDE of a preset — strips the custom entry AND hides the preset', () => {
    // The exact corrupt shape from prod: a preset exec present in BOTH customModels and hiddenPresets.
    const s: ModelState = {
      allowed: [PRESET],
      customModels: [{ label: 'DeepSeek V4 Pro', exec: PRESET }],
      hiddenPresets: [PRESET],
      modelNotes: {},
    };
    const next = removeModel(s, PRESET);
    expect(next.customModels.some((m) => m.exec === PRESET)).toBe(false); // custom copy gone (the old bug kept it)
    expect(next.hiddenPresets).toContain(PRESET);                          // preset still suppressed
    expect(allModels(next.customModels, next.hiddenPresets).some((m) => m.exec === PRESET)).toBe(false); // truly gone
  });

  it('removes a pure custom model without touching hiddenPresets', () => {
    const s: ModelState = { allowed: ['x/y'], customModels: [{ label: 'Y', exec: 'x/y' }], hiddenPresets: [], modelNotes: {} };
    const next = removeModel(s, 'x/y');
    expect(next.customModels).toEqual([]);
    expect(next.hiddenPresets).toEqual([]);
  });

  it('drops the deleted model\'s note so it cannot re-attach later', () => {
    const s: ModelState = { allowed: ['x/y'], customModels: [{ label: 'Y', exec: 'x/y' }], hiddenPresets: [], modelNotes: { 'x/y': 'a coder', other: 'keep' } };
    const next = removeModel(s, 'x/y');
    expect(next.modelNotes).toEqual({ other: 'keep' }); // x/y note gone, others untouched
  });
});

describe('upsertModel', () => {
  it('adds a new custom model and enables it', () => {
    const s: ModelState = { allowed: ['sonnet'], customModels: [], hiddenPresets: [], modelNotes: {} };
    const next = upsertModel(s, { label: 'New', exec: 'prov/new' });
    expect(next.customModels).toEqual([{ label: 'New', exec: 'prov/new' }]);
    expect(next.allowed).toContain('prov/new');
  });

  it('renames a custom model in place — no leftover duplicate', () => {
    const s: ModelState = { allowed: ['old/x'], customModels: [{ label: 'Old', exec: 'old/x' }], hiddenPresets: [], modelNotes: {} };
    const next = upsertModel(s, { label: 'New', exec: 'new/x' }, 'old/x');
    expect(next.customModels).toEqual([{ label: 'New', exec: 'new/x' }]); // single entry, old exec dropped
    expect(next.allowed).toContain('new/x');
    expect(next.allowed).not.toContain('old/x');
  });

  it('editing a preset to a NEW exec hides the preset and leaves exactly one custom entry', () => {
    // Reproduces the prod duplicate: editing the DeepSeek preset must not leave two entries behind.
    const s: ModelState = { allowed: [PRESET], customModels: [], hiddenPresets: [], modelNotes: {} };
    const next = upsertModel(s, { label: 'DeepSeek V4 Pro', exec: 'deepseek/deepseek-v4-pro' }, PRESET);
    expect(next.hiddenPresets).toContain(PRESET);                                // original preset suppressed
    expect(next.customModels).toEqual([{ label: 'DeepSeek V4 Pro', exec: 'deepseek/deepseek-v4-pro' }]);
    const merged = allModels(next.customModels, next.hiddenPresets).filter((m) => m.label === 'DeepSeek V4 Pro');
    expect(merged).toHaveLength(1);                                              // exactly one, not a duplicate
  });

  it('editing an already-custom override of a preset (same exec) keeps a single entry', () => {
    const s: ModelState = { allowed: [PRESET], customModels: [{ label: 'Old label', exec: PRESET }], hiddenPresets: [PRESET], modelNotes: {} };
    const next = upsertModel(s, { label: 'New label', exec: PRESET }, PRESET);
    expect(next.customModels).toEqual([{ label: 'New label', exec: PRESET }]); // replaced in place
    expect(allModels(next.customModels, next.hiddenPresets).filter((m) => m.exec === PRESET)).toHaveLength(1);
  });

  it('carries the note onto the new exec when a model is renamed (the disappearing-description bug)', () => {
    // Exactly Filip's case: edit DeepSeek preset from the ollama-cloud exec to the official one.
    const s: ModelState = { allowed: [PRESET], customModels: [], hiddenPresets: [], modelNotes: { [PRESET]: 'strong reviewer' } };
    const next = upsertModel(s, { label: 'DeepSeek V4 Pro', exec: 'deepseek/deepseek-v4-pro' }, PRESET);
    expect(next.modelNotes['deepseek/deepseek-v4-pro']).toBe('strong reviewer'); // note followed the rename
    expect(next.modelNotes[PRESET]).toBeUndefined();                             // no orphan under the old exec
  });

  it('leaves notes untouched on a same-exec edit', () => {
    const s: ModelState = { allowed: ['x/y'], customModels: [{ label: 'Old', exec: 'x/y' }], hiddenPresets: [], modelNotes: { 'x/y': 'keep me' } };
    const next = upsertModel(s, { label: 'New label', exec: 'x/y' }, 'x/y');
    expect(next.modelNotes).toEqual({ 'x/y': 'keep me' });
  });
});
