import { describe, it, expect, vi } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { capExternalToolSchema, MAX_EXTERNAL_TOOL_BYTES, MAX_EXTERNAL_DESCRIPTION_BYTES } from '../../src/brain/toolSchemaCap.js';
import { composeSessionTools } from '../../src/brain/session/capabilities.js';
import { validateToolArguments } from '@earendil-works/pi-ai';

/** A tool definition with a parameter schema of roughly `bytes` serialized size. */
function tool(name: string, schemaBytes: number, description = 'does a thing'): ToolDefinition {
  const properties: Record<string, unknown> = {};
  for (let i = 0; properties && JSON.stringify(properties).length < schemaBytes; i += 1) {
    properties[`field_${i}`] = { type: 'string', description: 'x'.repeat(200) };
  }
  return { name, description, parameters: { type: 'object', properties }, execute: async () => ({}) } as unknown as ToolDefinition;
}

const serializedBytes = (t: ToolDefinition): number =>
  Buffer.byteLength(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }), 'utf8');

describe('capExternalToolSchema', () => {
  it('leaves a normal external tool exactly as the server supplied it', () => {
    const original = tool('mcp__github__list_issues', 500);
    expect(capExternalToolSchema(original)).toBe(original); // identity: nothing was rebuilt
  });

  it('drops the schema of an oversized external tool and says so in its description', () => {
    const onCapped = vi.fn();
    const capped = capExternalToolSchema(tool('mcp__verbose__do_everything', 20_000), onCapped);

    expect(capped.parameters).toEqual({ type: 'object', additionalProperties: true });
    // The model must still be able to try the call — the server is the validator, not us.
    expect(capped.description).toContain('parameter schema was too large');
    expect(capped.description).toContain('the server validates them');
    expect(serializedBytes(capped)).toBeLessThan(MAX_EXTERNAL_TOOL_BYTES);
    expect(onCapped).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mcp__verbose__do_everything', schemaOmitted: true }));
    expect(onCapped.mock.calls[0]![0].bytes).toBeGreaterThan(MAX_EXTERNAL_TOOL_BYTES);
  });

  it('never touches a tool of ours, however large its schema', () => {
    // Our own definitions are written deliberately; the largest measured on this instance is Delegate at
    // 6.4 kB. Trimming them would degrade the model's behaviour to save bytes we chose to spend.
    const ours = tool('Delegate', 20_000);
    expect(capExternalToolSchema(ours)).toBe(ours);
    expect(serializedBytes(capExternalToolSchema(ours))).toBeGreaterThan(MAX_EXTERNAL_TOOL_BYTES);
  });

  it('bounds an external description in BYTES, not characters', () => {
    // The MCP plugin's existing 1024-CHARACTER slice lets a non-Latin description through at roughly
    // three times its stated size, which is the hole this closes.
    const long = '\u5b57'.repeat(1_000); // 3000 bytes, 1000 characters
    const capped = capExternalToolSchema(tool('mcp__x__y', 100, long));

    // The cut mark counts against the budget rather than being added on top of it.
    expect(Buffer.byteLength(capped.description ?? '', 'utf8')).toBeLessThanOrEqual(MAX_EXTERNAL_DESCRIPTION_BYTES);
    expect(capped.description).not.toContain('\uFFFD'); // cut on a character boundary, not mid-character
    expect(capped.description?.endsWith('…')).toBe(true);
  });

  it('keeps the omission notice readable even when the description itself was already at the cap', () => {
    const capped = capExternalToolSchema(tool('mcp__x__y', 20_000, 'd'.repeat(5_000)));

    expect(capped.description).toContain('parameter schema was too large');
    expect(Buffer.byteLength(capped.description ?? '', 'utf8')).toBeLessThanOrEqual(MAX_EXTERNAL_DESCRIPTION_BYTES);
  });

  it('reports a description it shortened even when the schema fitted', () => {
    // A silently trimmed description is still a third-party tool the model no longer sees in full, so
    // the operator has to learn about it too — not only about the dropped schemas.
    const onCapped = vi.fn();
    capExternalToolSchema(tool('mcp__x__y', 100, 'd'.repeat(5_000)), onCapped);
    expect(onCapped).toHaveBeenCalledWith(expect.objectContaining({ name: 'mcp__x__y', schemaOmitted: false }));
  });

  it('reports the size the server supplied, not the size left after trimming it', () => {
    // The decision is made on the post-clamp size, but the REPORT has to name the original: understating
    // the worst offenders by exactly the amount that made them worth reporting leaves the operator
    // hunting for a server that looks modest in the log.
    const onCapped = vi.fn();
    const original = tool('mcp__loud__thing', 100, 'd'.repeat(9_000));
    capExternalToolSchema(original, onCapped);
    expect(onCapped.mock.calls[0]![0].bytes).toBeGreaterThan(9_000);
    expect(onCapped.mock.calls[0]![0].bytes).toBeCloseTo(serializedBytes(original), -2);
  });

  it('reports nothing for a tool it did not have to reduce', () => {
    const onCapped = vi.fn();
    capExternalToolSchema(tool('mcp__small__ok', 100), onCapped);
    expect(onCapped).not.toHaveBeenCalled();
  });
});

describe('composeSessionTools with an oversized external tool', () => {
  it('bounds it in the composed set and leaves it callable', async () => {
    const ran = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const big = { ...tool('mcp__verbose__do_everything', 20_000), execute: ran } as unknown as ToolDefinition;
    const composed = composeSessionTools({ kind: 'owner-chat', pluginTools: [big] });
    const capped = composed.find((t) => t.name === 'mcp__verbose__do_everything')!;

    expect(capped.parameters).toEqual({ type: 'object', additionalProperties: true });
    // The replacement is a plain JSON Schema, not a TypeBox one — it has no `[Kind]` symbol. PI's own
    // argument validator runs BEFORE execute in a real turn, so a schema it rejected would leave the
    // tool advertised and uncallable, which is worse than the oversized schema this cap exists to stop.
    const args = validateToolArguments(capped as never, {
      type: 'toolCall', id: 'call-1', name: capped.name, arguments: { anything: 1, nested: { a: [1, 2] } },
    } as never);
    expect(args).toEqual({ anything: 1, nested: { a: [1, 2] } });

    // …and the gates still wrap a working execute around it.
    await capped.execute('call-1', args as never, {} as never);
    expect(ran).toHaveBeenCalledTimes(1);
  });
});
