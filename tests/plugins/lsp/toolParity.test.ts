import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registeredLspTools } from './harness.js';

/** PROMPT-CACHE PARITY BASELINE for the brain tools that moved into the lsp plugin. The advertised
 *  bytes of a tool (name, label, description, parameter schema) feed the model's cached prompt prefix,
 *  so they are pinned here EXACTLY as the core built-ins shipped them. Changing any of these strings
 *  invalidates every cached prompt — if that is intended, update the baseline consciously.
 *  The advertised ORDER changed once with the extraction (plugin tools compose after the core groups);
 *  tests/plugins/agents/toolParity.test.ts locks the composed owner-chat sequence. */
const BASELINE = [
  {
    name: 'LspDiagnostics',
    label: 'Check diagnostics',
    description: 'Type-check a file with its language server (LSP) and return errors/warnings with exact line:column. Call this right after editing a code file to immediately confirm it still compiles. Returns "no problems" for a clean file, and a clear note when LSP is off (/lsp) or no server is installed for the language.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file to check' } }, required: ['path'] },
  },
  {
    name: 'LspGoToDefinition',
    label: 'Go to definition',
    description: 'Find where a symbol (function, class, variable) is defined using the language server. Returns the file path and line:column of the definition. Requires LSP to be enabled and a server installed for the file\'s language.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file containing the symbol' },
        line: { type: 'number', description: 'Line number (1-based) of the symbol' },
        character: { type: 'number', description: 'Character offset (1-based) of the symbol' },
      },
      required: ['path', 'line', 'character'],
    },
  },
  {
    name: 'LspFindReferences',
    label: 'Find references',
    description: 'Find all references to a symbol (function, class, variable) across the workspace using the language server. Returns a list of file:line:column locations. Requires LSP to be enabled and a server installed for the file\'s language.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file containing the symbol' },
        line: { type: 'number', description: 'Line number (1-based) of the symbol' },
        character: { type: 'number', description: 'Character offset (1-based) of the symbol' },
      },
      required: ['path', 'line', 'character'],
    },
  },
  {
    name: 'LspHover',
    label: 'Hover info',
    description: 'Get hover information (documentation, type signature) for a symbol at a position using the language server. Returns the symbol\'s type and doc comment. Requires LSP to be enabled and a server installed for the file\'s language.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file containing the symbol' },
        line: { type: 'number', description: 'Line number (1-based) of the symbol' },
        character: { type: 'number', description: 'Character offset (1-based) of the symbol' },
      },
      required: ['path', 'line', 'character'],
    },
  },
  {
    name: 'LspDocumentSymbol',
    label: 'Document symbols',
    description: 'List all symbols (functions, classes, variables, interfaces) in a file using the language server. Returns a hierarchical outline of the document. Requires LSP to be enabled and a server installed for the file\'s language.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file' } }, required: ['path'] },
  },
  {
    name: 'LspWorkspaceSymbol',
    label: 'Workspace symbols',
    description: 'Search for symbols (functions, classes, variables) across the entire workspace by name using the language server. Returns matching symbols with their file locations. Requires LSP to be enabled and at least one server running.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Symbol name to search for (fuzzy match)' } }, required: ['query'] },
  },
];

describe('lsp plugin tool parity (prompt cache)', () => {
  it('registers the moved tools byte-identical to the core originals, in the same order', () => {
    const tools = registeredLspTools();
    expect(tools.map((t) => t.name)).toEqual(BASELINE.map((b) => b.name));
    for (const b of BASELINE) {
      const t = tools.find((x) => x.name === b.name)!;
      expect(t.label).toBe(b.label);
      expect(t.description).toBe(b.description);
      // The parameter schema reaches the model as JSON — compare the serialized form EXACTLY (typebox
      // symbols do not survive JSON, so this IS the wire shape). toEqual, never toMatchObject: a new
      // property, or a `required` entry that quietly went missing, is drift the model sees and the
      // prompt cache bills for, and toMatchObject would let both through.
      expect(JSON.parse(JSON.stringify(t.parameters))).toEqual(b.parameters);
    }
  });

  it('the manifest declares exactly these tools, as plan-safe and output-shown', () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'plugins', 'lsp', 'elowen-plugin.json'), 'utf-8'),
    ) as { provides?: { tools?: string[] }; planSafe?: string[]; showOutput?: string[]; icons?: Record<string, string> };
    const names = BASELINE.map((b) => b.name);
    // Deny-by-default: a tool missing from `provides.tools` is refused at registration.
    expect(manifest.provides?.tools).toEqual(names);
    // These were core plan-safe names (BUILTIN_TOOL_PLAN_SAFE) and a core `showOutput` pattern; the
    // manifest is what carries them now, so plan mode and the transcript behave exactly as before.
    expect(manifest.planSafe).toEqual(names);
    expect(manifest.showOutput).toEqual(['Lsp*']);
    expect(Object.keys(manifest.icons ?? {})).toEqual(names);
  });
});
