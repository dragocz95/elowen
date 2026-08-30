import { describe, expect, it } from 'vitest';
import { installCacheBreakpoints } from '../../src/brain/session/cacheBreakpoints.js';
import { canonicalPayload } from '../../src/brain/session/cacheWatch.js';
import { providerPayloadHarness, type WirePayload } from '../helpers/providerPayloads.js';

/** The prompt cache is prefix-based, so the one property every turn-composition change must preserve is
 *  that request N+1 opens with request N's messages, byte for byte. Nothing asserted that until now:
 *  `cacheWatch` notices a break at RUNTIME, on a live conversation, once the tokens are already paid for.
 *
 *  These tests exist to catch the specific way that property is easy to lose — a block that stops being
 *  composed into the user message, or starts being composed differently. Omitting a block shortens a NEW
 *  message and must leave the prefix untouched; rewriting an OLD one would not, and would be invisible
 *  until a bill arrived.
 *
 *  WHAT THIS DOES AND DOES NOT COVER, because the distinction is easy to get wrong from the file name.
 *  It drives a REAL `createAgentSession` and reads the post-transform payload, so it proves the SHAPE of
 *  the property: shortening or omitting content in the newest message never rewrites an earlier one, and
 *  the breakpoint machinery behaves the same when a block disappears. It does NOT run the production
 *  composers — `recallMemoryBlock`, `decideAmbientBlock` and both turn composers are absent, the blocks
 *  here are literal strings — and it does not exercise compaction, tool calls, a changing tool set or the
 *  MCP schema cap. So it is a guard on the INVARIANT, not on the four features that rely on it: a
 *  regression inside any of those is caught by that feature's own tests, not here. Widening it to drive
 *  the real composers would mean standing up the whole BrainService in a cache test; the honest split is
 *  to say so rather than to let the name imply coverage it does not have. */

/** Every message the earlier request sent must still be present, unchanged and in the same position.
 *  Compared through `canonicalPayload` so the `cache_control` marker pi-ai moves onto the payload's last
 *  message each request cannot masquerade as a rewrite — the exact equality `cacheBreakpoints` uses. */
function expectPrefixPreserved(earlier: WirePayload, later: WirePayload): void {
  expect(later.messages.length).toBeGreaterThanOrEqual(earlier.messages.length);
  for (let index = 0; index < earlier.messages.length; index += 1) {
    // Asserted per message rather than over the whole slice: a failure then names the diverging index
    // instead of printing two transcripts and leaving the reader to diff them.
    expect(canonicalPayload(later.messages[index])).toEqual(canonicalPayload(earlier.messages[index]));
  }
}

/** Guard against a vacuous pass: a turn that appended nothing would satisfy every prefix assertion. */
function expectAppended(earlier: WirePayload, later: WirePayload, text: string): void {
  expect(later.messages.length).toBeGreaterThan(earlier.messages.length);
  const appended = later.messages.slice(earlier.messages.length)
    .map((message) => message.content.map((block) => block.text).join(''))
    .join('\n');
  expect(appended).toContain(text);
}

const PERMISSIONS = '<permissions>\nBash: ask\n</permissions>\n\n';

describe('prompt prefix stability', () => {
  it('opens the next request with the previous request verbatim', async () => {
    const harness = await providerPayloadHarness({ extensionFactories: [installCacheBreakpoints] });

    const [first] = await harness.prompt('first question');
    const [second] = await harness.prompt('second question');

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expectPrefixPreserved(first!, second!);
    expectAppended(first!, second!, 'second question');
  });

  it('keeps the system prompt and tool block byte-identical across turns', async () => {
    const harness = await providerPayloadHarness({ extensionFactories: [installCacheBreakpoints] });

    const [first] = await harness.prompt('first question');
    const [second] = await harness.prompt('second question');

    // Not canonicalized: these two carry no marker, so anything but exact equality is a real change —
    // and a changed system prompt or tool array invalidates the whole cached prefix, not just its tail.
    expect(JSON.stringify(second!.system)).toBe(JSON.stringify(first!.system));
    expect(JSON.stringify(second!.tools)).toBe(JSON.stringify(first!.tools));
  });

  it('survives an ambient block that is omitted on a later turn', async () => {
    const harness = await providerPayloadHarness({ extensionFactories: [installCacheBreakpoints] });

    // Turn 1 carries the permission summary; turn 2 omits it because nothing changed. That is exactly
    // what the ambient-block change does, and the shorter message must not disturb what came before.
    const [first] = await harness.prompt(`${PERMISSIONS}first question`);
    const [second] = await harness.prompt('second question');

    expectPrefixPreserved(first!, second!);
    const secondText = second!.messages.map((message) => message.content.map((block) => block.text).join('')).join('\n');
    expect(secondText).toContain(PERMISSIONS);
    expect(secondText.match(/<permissions>/g)).toHaveLength(1);
  });

  it('survives an ambient block whose content changed', async () => {
    const harness = await providerPayloadHarness({ extensionFactories: [installCacheBreakpoints] });

    const [first] = await harness.prompt(`${PERMISSIONS}first question`);
    const [second] = await harness.prompt('<permissions>\nBash: allow\n</permissions>\n\nsecond question');

    // A re-sent block is APPENDED as part of a new message; the earlier one stays where it was.
    expectPrefixPreserved(first!, second!);
    expectAppended(first!, second!, 'Bash: allow');
  });

  it('fails when an earlier message is rewritten in place', async () => {
    // The guard is only worth having if it catches the thing it is aimed at. A handler that edits an
    // already-sent message is exactly the defect no unit test would otherwise notice, so assert that the
    // comparison rejects it rather than trusting that it would.
    let request = 0;
    const rewriteHistory = (pi: Parameters<typeof installCacheBreakpoints>[0]): void => {
      pi.on('before_provider_request', (event) => {
        request += 1;
        if (request < 2) return undefined;
        const payload = event.payload as WirePayload;
        const first = payload.messages[0]?.content[0];
        if (first) first.text = `${first.text} (rewritten)`;
        return payload;
      });
    };
    const harness = await providerPayloadHarness({ extensionFactories: [rewriteHistory] });

    const [first] = await harness.prompt('first question');
    const [second] = await harness.prompt('second question');

    expect(() => expectPrefixPreserved(first!, second!)).toThrow();
  });

  it('survives a turn that omits every ambient block at once', async () => {
    const harness = await providerPayloadHarness({ extensionFactories: [installCacheBreakpoints] });

    const [first] = await harness.prompt(
      `<available_skills>\nskill list\n</available_skills>\n\n${PERMISSIONS}<user_memories>\nrecalled\n</user_memories>\n\nfirst question`,
    );
    const [second] = await harness.prompt('x');

    expectPrefixPreserved(first!, second!);
    expectAppended(first!, second!, 'x');
  });
});
