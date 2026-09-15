import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rawTemplate } from '../../src/prompts/index.js';

const fixture = join(import.meta.dirname, '..', 'fixtures', 'promptAdoptedGuidance.md');

function pinnedGuidance(): string[] {
  return readFileSync(fixture, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** The interactive persona as a session receives it: identity, harness, our own work rules, in order.
 *  The pinned rules live across all three parts, so a per-file assertion would only pin a third of them. */
const composedPersona = (): string =>
  ['elowen', 'elowen-harness', 'elowen-work'].map((name) => rawTemplate(name)).join('\n\n');

// The owner authorized a full Markdown rewrite, replacing the old verbatim XML paragraphs.
// Keep the communication, autonomy, continuity, and permission rules pinned in their new wording.
// An intentional future change must still update the fixture explicitly.
describe('adopted prompt guidance', () => {
  it('carries every pinned rule in the composed persona', () => {
    const template = normalized(composedPersona());
    const pinned = pinnedGuidance();
    expect(pinned.length).toBeGreaterThanOrEqual(40);
    expect(pinned.filter((rule) => !template.includes(rule))).toEqual([]);
  });

  it('keeps guidance in the Markdown sections that own it, in the part that owns the section', () => {
    const section = (part: string, name: string): string => {
      const body = rawTemplate(part).split(`\n## ${name}\n`)[1]?.split('\n## ')[0];
      expect(body, `section ${name} missing from ${part}`).toBeDefined();
      return normalized(body!);
    };

    expect(section('elowen', 'Permissions and safety')).toContain('Authorization and preferences persist across turns');
    expect(section('elowen', 'Voice')).toContain('be a curious, thoughtful collaborator');
    expect(section('elowen-harness', 'Session guidance')).toContain('name and link to the exact SKILL.md you read');
    expect(section('elowen-harness', 'Context management')).toContain('Treat new messages as steering');
    expect(section('elowen-work', 'Delivering work')).toContain('carry authorized work through to completion');
    expect(section('elowen-work', 'Writing for the user')).toContain('a final answer to yield back to the user');
  });

  it('places the configured personality after the baseline personality paragraph', () => {
    expect(normalized(rawTemplate('elowen')))
      .toContain('without flattery or forced enthusiasm. {{personality}}');
  });
});
