import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAgentFile,
  resolveAgentTools,
  subagentCatalog,
  loadAgentRegistry,
  READ_ONLY_AGENT_TOOLS,
  type AgentDef,
} from '../../../src/brain/agents/agentRegistry.js';

let dirs: string[] = [];
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

const md = (frontmatter: string, body: string): string => `---\n${frontmatter}\n---\n${body}`;

describe('parseAgentFile', () => {
  it('parses a valid read-only agent', () => {
    const def = parseAgentFile(
      md('name: explore\ndescription: Search stuff\ntools: read-only', 'You are explore.'),
      'builtin', '/x/explore.md',
    );
    expect(def).toMatchObject({
      name: 'explore', description: 'Search stuff', toolsSpec: 'read-only',
      body: 'You are explore.', source: 'builtin',
    });
  });

  it('reads the tools spec in every form (list / all / inherit-when-missing / readonly alias)', () => {
    expect(parseAgentFile(md('name: aa\ndescription: d\ntools: [Read, Bash]', 'b'), 'user', '/x')?.toolsSpec).toEqual(['Read', 'Bash']);
    expect(parseAgentFile(md('name: aa\ndescription: d\ntools: all', 'b'), 'user', '/x')?.toolsSpec).toBe('all');
    expect(parseAgentFile(md('name: aa\ndescription: d', 'b'), 'user', '/x')?.toolsSpec).toBe('inherit');
    expect(parseAgentFile(md('name: aa\ndescription: d\ntools: readonly', 'b'), 'user', '/x')?.toolsSpec).toBe('read-only');
  });

  it('rejects an invalid file rather than loading a half-formed agent', () => {
    expect(parseAgentFile('no frontmatter at all', 'user', '/x')).toBeNull();
    expect(parseAgentFile(md('name: Bad Name\ndescription: d', 'b'), 'user', '/x')).toBeNull(); // name not kebab
    expect(parseAgentFile(md('name: ok', 'b'), 'user', '/x')).toBeNull();                       // no description
    expect(parseAgentFile(md('name: ok\ndescription: d\ntools: []', 'b'), 'user', '/x')).toBeNull(); // empty list
    expect(parseAgentFile(md('name: ok\ndescription: d\ntools: 42', 'b'), 'user', '/x')).toBeNull(); // bad type
    expect(parseAgentFile(md('name: ok\ndescription: d', ''), 'user', '/x')).toBeNull();         // empty body
  });

  it('never throws on malformed YAML — returns null', () => {
    expect(parseAgentFile(md('name: [unterminated', 'b'), 'user', '/x')).toBeNull();
  });

  it('keeps a --- horizontal rule in the body as body (frontmatter ends at the first --- line)', () => {
    const def = parseAgentFile(
      md('name: explore\ndescription: Search stuff\ntools: read-only', 'Part one.\n\n---\n\nPart two.'),
      'builtin', '/x/explore.md',
    );
    expect(def).not.toBeNull();
    expect(def!.body).toBe('Part one.\n\n---\n\nPart two.');
  });

  it('parses a CRLF agent file (was rejected before the shared frontmatter split)', () => {
    const def = parseAgentFile(
      '---\r\nname: explore\r\ndescription: Search stuff\r\ntools: read-only\r\n---\r\nBody.\r\n',
      'builtin', '/x/explore.md',
    );
    expect(def).toMatchObject({ name: 'explore', description: 'Search stuff', body: 'Body.' });
  });

  it('parses a BOM-prefixed agent file', () => {
    const def = parseAgentFile(
      '\uFEFF---\nname: explore\ndescription: Search stuff\ntools: read-only\n---\nBody.\n',
      'builtin', '/x/explore.md',
    );
    expect(def).toMatchObject({ name: 'explore', description: 'Search stuff', body: 'Body.' });
  });
});

describe('resolveAgentTools', () => {
  const def = (toolsSpec: AgentDef['toolsSpec']): AgentDef =>
    ({ name: 'a', description: 'd', body: 'b', toolsSpec, source: 'user', filePath: '/x' });

  it('maps read-only to the read-only toolset including Bash', () => {
    expect(resolveAgentTools(def('read-only'))).toEqual(READ_ONLY_AGENT_TOOLS);
    expect(resolveAgentTools(def('read-only'))).toContain('Bash');
  });
  it('maps all / inherit to no restriction and a list to itself', () => {
    expect(resolveAgentTools(def('all'))).toBeUndefined();
    expect(resolveAgentTools(def('inherit'))).toBeUndefined();
    expect(resolveAgentTools(def(['Read', 'Search']))).toEqual(['Read', 'Search']);
  });
});

describe('loadAgentRegistry', () => {
  it('merges built-in then user, a user file overrides a built-in of the same name, and skips broken files', () => {
    const root = mkdtempSync(join(tmpdir(), 'elowen-agents-'));
    dirs.push(root);
    const builtin = join(root, 'builtin');
    const user = join(root, 'user');
    mkdirSync(builtin);
    mkdirSync(user);
    writeFileSync(join(builtin, 'explore.md'), md('name: explore\ndescription: builtin explore\ntools: read-only', 'builtin body'));
    writeFileSync(join(builtin, 'plan.md'), md('name: plan\ndescription: builtin plan\ntools: read-only', 'plan body'));
    writeFileSync(join(user, 'explore.md'), md('name: explore\ndescription: user explore\ntools: all', 'user body'));
    writeFileSync(join(user, 'custom.md'), md('name: custom\ndescription: my custom\ntools: [Read]', 'custom body'));
    writeFileSync(join(user, 'broken.md'), 'not an agent definition');

    const reg = loadAgentRegistry({ builtinDir: builtin, userDir: user });
    expect([...reg.keys()].sort()).toEqual(['custom', 'explore', 'plan']);
    // User overrides the built-in explore (description, source and tools all come from the user file).
    expect(reg.get('explore')).toMatchObject({ description: 'user explore', source: 'user', toolsSpec: 'all' });
    expect(reg.get('plan')?.source).toBe('builtin');
    expect(subagentCatalog(reg)).toContainEqual({ name: 'custom', description: 'my custom' });
  });

  it('returns an empty map when the dirs do not exist', () => {
    expect(loadAgentRegistry({ builtinDir: '/no/such/dir', userDir: undefined }).size).toBe(0);
  });
});
