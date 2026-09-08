import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rawTemplate } from '../../src/prompts/index.js';

const fixture = join(import.meta.dirname, '..', 'fixtures', 'promptAdoptedGuidance.md');

/** One line per adopted paragraph, comments and blank lines dropped. */
function pinnedParagraphs(): string[] {
  return readFileSync(fixture, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** The prompt is hard-wrapped for readability, so a paragraph's line breaks are layout, not content.
 *  Comparing on whitespace-normalized text pins the wording and lets the wrapping move freely. */
function normalized(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** The communication, autonomy and permission guidance in `elowen.md` was adopted word for word from the
 *  reference agent prompt the owner approved. Nothing else marks it as verbatim, so an ordinary tidy-up
 *  edit would erode it one sentence at a time. Pinning it against a fixture makes every reword deliberate:
 *  the test fails, and updating the fixture is the explicit act of changing the adopted wording. */
describe('adopted prompt guidance', () => {
  it('carries every pinned paragraph verbatim in prompts/elowen.md', () => {
    const template = normalized(rawTemplate('elowen'));
    const pinned = pinnedParagraphs();

    // Guards the pin itself: an empty or truncated fixture would make the loop below pass vacuously.
    expect(pinned.length).toBeGreaterThanOrEqual(33);

    const missing = pinned.filter((paragraph) => !template.includes(paragraph));
    expect(missing).toEqual([]);
  });

  it('keeps the adopted paragraphs in the sections that own them', () => {
    const template = rawTemplate('elowen');
    const section = (name: string): string => {
      const body = template.split(`<${name}>`)[1]?.split(`</${name}>`)[0];
      expect(body, `section ${name} missing`).toBeDefined();
      return normalized(body!);
    };

    expect(section('authority_and_safety')).toContain('Use your best judgement given task context');
    expect(section('delivering_work')).toContain('Your job is to bias towards action');
    expect(section('relationship_and_communication')).toContain('you are a curious, thoughtful collaborator');
    expect(section('working_with_the_user')).toContain('the last message you write is the final answer');
    expect(section('session_guidance')).toContain('name and link to the exact SKILL.md you read');
  });

  it('renders the configured personality right after the personality paragraph', () => {
    const template = normalized(rawTemplate('elowen'));
    // Both must apply: the adopted paragraph sets the baseline, the overlay tunes it. Order is the
    // contract — a personality slot placed before the paragraph would read as overridden by it.
    expect(template).toMatch(/without flattery or forced enthusiasm\. <communication_style>\{\{personality\}\}<\/communication_style>/);
  });
});
