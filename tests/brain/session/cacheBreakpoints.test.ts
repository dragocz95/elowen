import { describe, it, expect } from 'vitest';
import { createTrailingCacheBreakpoint } from '../../../src/brain/session/cacheBreakpoints.js';
import type { TrailingCacheBreakpoint } from '../../../src/brain/session/cacheBreakpoints.js';
import { buildForkChildMessage, FORK_PLACEHOLDER_RESULT } from '../../../src/brain/session/forkPrefix.js';

const EPHEMERAL = { type: 'ephemeral', ttl: '1h' };

/** A payload shaped the way pi-ai builds one for a non-OAuth token: one marked system block, the last
 *  tool marked, and the marker on the last block of the last user message — three of the four slots. */
function payload(messages: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    system: [{ type: 'text', text: 'system', cache_control: EPHEMERAL }],
    tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: EPHEMERAL }],
    messages,
    ...extra,
  };
}

const marked = (text: string): Record<string, unknown> => ({ type: 'text', text, cache_control: EPHEMERAL });
const plain = (text: string): Record<string, unknown> => ({ type: 'text', text });
const userMessage = (...content: unknown[]): Record<string, unknown> => ({ role: 'user', content });
const assistantMessage = (text: string): Record<string, unknown> => ({ role: 'assistant', content: [plain(text)] });

type MarkedPayload = { system?: { cache_control?: unknown }[]; messages: { content: { cache_control?: unknown }[] }[] };

/** Every message-level marker in the payload, in order, so a test can assert WHERE they landed. */
function markerPositions(value: unknown): string[] {
  const out: string[] = [];
  ((value as MarkedPayload).messages ?? []).forEach((message, index) => {
    (message.content ?? []).forEach((block) => {
      if (block.cache_control !== undefined) out.push(`${index}`);
    });
  });
  return out;
}

/** Run one request through the breakpoint and report its provider outcome — the shape the extension
 *  wiring produces (before_provider_request, then after_provider_response). */
function send(bp: TrailingCacheBreakpoint, value: unknown, status = 200): unknown {
  const result = bp.request(value);
  bp.response(status);
  return result;
}

describe('createTrailingCacheBreakpoint', () => {
  // The whole point: pi-ai's single marker MOVES to the new tail every request, and the previous
  // request's cache write happened exactly where it sat THEN. Re-marking that remembered position makes
  // the next lookup an exact hit, whatever the step appended in between.
  it('marks, on the next request, the message that carried the marker on the previous one', () => {
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([userMessage(marked('ask'))]));
    const result = send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('calling tools'),
      userMessage({ type: 'tool_result', content: 'a' }, marked('done')),
    ]));
    expect(markerPositions(result)).toEqual(['0', '2']);
    // A single marked system block (non-OAuth) is not a duplicate and must survive untouched.
    expect((result as MarkedPayload).system?.[0]?.cache_control).toEqual(EPHEMERAL);
  });

  // The production incident: a step appended 13 messages (steering mode "all", background delegation
  // deliveries), so "the user message before the marked one" was a NEWLY APPENDED message no request had
  // ever written a cache entry at. Only the remembered position is a real write.
  it('pins the remembered position, not a guess, when a step appended several user messages', () => {
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(marked('turn tail')),
    ]));
    const result = send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(plain('turn tail')),
      assistantMessage('fanned out'),
      userMessage(plain('delegation result')), // where "previous user message" would wrongly land
      assistantMessage('kept going'),
      userMessage(marked('newest')),
    ]));
    expect(markerPositions(result)).toEqual(['2', '6']);
  });

  // With an OAuth token pi-ai marks BOTH system blocks (Claude Code identity + system prompt), which
  // together with the tools and last-user markers exhausts all four slots — the configuration this
  // module runs under in production, where the four-slot guard made the first version a silent no-op.
  // The identity entry duplicates the all-tools entry one tiny block later, so it is the one to free.
  it('frees the slot an OAuth payload wastes on the duplicate system marker', () => {
    const oauthSystem = (): Record<string, unknown>[] => [
      { type: 'text', text: 'You are Claude Code', cache_control: EPHEMERAL },
      { type: 'text', text: 'the real system prompt', cache_control: EPHEMERAL },
    ];
    const bp = createTrailingCacheBreakpoint();
    const first = send(bp, payload([userMessage(marked('ask'))], { system: oauthSystem() }));
    // Deduplicated from the very first request, so cache write positions never flicker.
    expect((first as MarkedPayload).system?.[0]?.cache_control).toBeUndefined();
    expect((first as MarkedPayload).system?.[1]?.cache_control).toEqual(EPHEMERAL);
    const result = send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(marked('next')),
    ], { system: oauthSystem() }));
    expect((result as MarkedPayload).system?.[0]?.cache_control).toBeUndefined();
    expect((result as MarkedPayload).system?.[1]?.cache_control).toEqual(EPHEMERAL);
    // The freed slot is spent on the trailing breakpoint.
    expect(markerPositions(result)).toEqual(['0', '2']);
  });

  // Anthropic rejects a request carrying more than four breakpoints, so a payload already at the limit
  // with nothing to strip must be left exactly as it is — an outage is worse than a cache miss. The
  // follow-up request proves the module was LIVE and tracking all along (a disabled module would also
  // leave the at-limit payload alone, which is why that assertion cannot stand by itself).
  it('never takes the payload past four breakpoints, and resumes the moment a slot frees up', () => {
    const twoMarkedTools = (): Record<string, unknown>[] => [
      { name: 'Read', input_schema: {}, cache_control: EPHEMERAL },
      { name: 'Write', input_schema: {}, cache_control: EPHEMERAL },
    ];
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([userMessage(marked('ask'))], { tools: twoMarkedTools() }));
    const atLimit = send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(marked('next')),
    ], { tools: twoMarkedTools() }));
    expect(markerPositions(atLimit)).toEqual(['2']);
    // Same conversation and the SAME tool list, but only one tool marker: a slot is free. Markers are
    // caching metadata outside the canonical prefix (canonical() strips cache_control), so the
    // remembered position (the previous request's mark at index 2) is still valid and gets pinned.
    const oneMarkedOfTwo = (): Record<string, unknown>[] => [
      { name: 'Read', input_schema: {} },
      { name: 'Write', input_schema: {}, cache_control: EPHEMERAL },
    ];
    const freed = send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(plain('next')),
      assistantMessage('more'),
      userMessage(marked('newest')),
    ], { tools: oneMarkedOfTwo() }));
    expect(markerPositions(freed)).toEqual(['2', '4']);
  });

  // The four-slot budget is per REQUEST, and a top-level payload marker (the automatic-breakpoint form)
  // is one of the four even though it sits on no system/tools/messages block. Under-counting it would
  // add a fifth marker — an HTTP 400 on every such request.
  it('counts a top-level payload marker toward the four-breakpoint budget', () => {
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([userMessage(marked('ask'))], { cache_control: EPHEMERAL }));
    const result = send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(marked('next')),
    ], { cache_control: EPHEMERAL }));
    // system + tools + last-user + root = four markers already: adding the trailing one is forbidden.
    expect(markerPositions(result)).toEqual(['2']);
  });

  // Reused verbatim from THIS request rather than remembered or reconstructed: the value encodes the TTL
  // derived from PI_CACHE_RETENTION, and a stale or literal value would silently disagree with the rest
  // of the payload the first time that setting changed.
  it('reuses the exact marker value pi-ai used on this request', () => {
    const FIVE_MINUTE = { type: 'ephemeral' };
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([userMessage(marked('ask'))]));
    const result = send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage({ type: 'text', text: 'next', cache_control: FIVE_MINUTE }),
    ]));
    expect((result as MarkedPayload).messages[0]?.content[0]?.cache_control).toEqual(FIVE_MINUTE);
  });

  // No marker means pi-ai deliberately did not cache this request. Adding one of our own would be
  // inventing a policy it chose not to apply — and a position remembered from before the gap describes a
  // write that may never have happened, so it must be forgotten, not carried across.
  it('adds nothing across an uncached request, and forgets what it knew before it', () => {
    const bare = { system: [{ type: 'text', text: 'system' }], tools: [{ name: 'Read', input_schema: {} }] };
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([userMessage(marked('ask'))]));
    const gap = send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(plain('next')),
    ], bare));
    expect(markerPositions(gap)).toEqual([]);
    const after = send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(plain('next')),
      assistantMessage('more'),
      userMessage(marked('newest')),
    ]));
    expect(markerPositions(after)).toEqual(['4']);
  });

  // The lookback only ever finds positions a request actually WROTE, and a request that died on a
  // 429/529/400 (or was cancelled before the provider took the input) wrote nothing. Remembering its
  // mark would pin exactly such a phantom position on the next request — which then follows a wide
  // fan-out often enough (an overload error right before the fan-out's delivery) that the protection
  // failed precisely when it was needed.
  it('remembers only a position whose request actually succeeded', () => {
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([userMessage(marked('ask'))])); // succeeded → position 0 is a real write
    send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(marked('doomed')),
    ]), 429); // the provider never processed this input — position 2 was never written
    const result = send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(plain('doomed')),
      assistantMessage('retrying'),
      userMessage(marked('newest')),
    ]));
    // The pin lands on the LAST SUCCESSFUL request's mark (index 0), not the failed one's (index 2).
    expect(markerPositions(result)).toEqual(['0', '4']);
  });

  it('a request whose response never arrived is not remembered either', () => {
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([userMessage(marked('ask'))]));
    bp.request(payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(marked('vanished')),
    ])); // aborted before any response event — no confirmation ever comes
    const result = send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(plain('vanished')),
      assistantMessage('recovered'),
      userMessage(marked('newest')),
    ]));
    expect(markerPositions(result)).toEqual(['0', '4']);
  });

  // Anthropic keys cache entries by the CUMULATIVE prefix. After a mid-history insertion the remembered
  // message still exists one position later, but every entry at or past the insertion point is
  // unreachable regardless of what is marked — so re-finding the message by its own content and marking
  // its shifted position (the previous design) could only ever spend the freed slot on a dead position.
  // The module abstains instead; the next successful request re-remembers and protection resumes.
  it('abstains after a mid-history insertion instead of marking a position whose prefix changed', () => {
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(marked('turn tail')),
    ]));
    const result = send(bp, payload([
      userMessage(plain('ask')),
      userMessage(plain('recalled memory')), // inserted — the prefix diverges from here on
      assistantMessage('working'),
      userMessage(plain('turn tail')), // shifted from 2 to 3; its cache entry is unreachable now
      assistantMessage('more'),
      userMessage(marked('newest')),
    ]));
    expect(markerPositions(result)).toEqual(['5']);
  });

  // The strongest reason the identity is the PREFIX hash and not the message hash: the remembered
  // message can sit at the remembered index with byte-identical content while something EARLIER
  // changed — after a compaction producing a lookalike tail, or an upstream egress rewrite. The cache
  // entry is keyed on the whole prefix, so it is gone, and marking the position would be a false pin.
  it('abstains when the remembered index still matches but the history before it changed', () => {
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([
      userMessage(plain('original opening')),
      assistantMessage('working'),
      userMessage(marked('turn tail')),
    ]));
    const result = send(bp, payload([
      userMessage(plain('REWRITTEN opening')), // same position, same length history — different prefix
      assistantMessage('working'),
      userMessage(plain('turn tail')), // identical message at the identical index
      assistantMessage('more'),
      userMessage(marked('newest')),
    ]));
    expect(markerPositions(result)).toEqual(['4']);
  });

  // After a compaction the remembered message is simply gone; marking any other position would pin a
  // spot no request ever wrote a cache entry at.
  it('adds nothing when the remembered message no longer exists', () => {
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([userMessage(marked('original opening'))]));
    const result = send(bp, payload([
      userMessage(plain('compaction summary')),
      assistantMessage('working'),
      userMessage(marked('fresh')),
    ]));
    expect(markerPositions(result)).toEqual(['2']);
  });

  // A marker on a block type Anthropic does not accept one on would make the whole request invalid.
  it('refuses to mark a block type that cannot carry a marker', () => {
    const oddTail = { type: 'something_new', value: 1 };
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([userMessage(marked('ask'), { ...oddTail })]));
    const result = send(bp, payload([
      userMessage(plain('ask'), { ...oddTail }),
      assistantMessage('working'),
      userMessage(marked('next')),
    ]));
    expect(markerPositions(result)).toEqual(['2']);
  });

  // A target that already carries a marker is someone else's decision (a doubled handler, a future
  // pi-ai change); overwriting it could silently swap its TTL.
  it('leaves a target that already carries a marker untouched', () => {
    const STALE = { type: 'ephemeral' };
    // Unmarked tools keep the payload below the four-marker budget, so this test exercises the
    // overwrite refusal itself rather than hiding behind the budget guard.
    const bareTools = { tools: [{ name: 'Read', input_schema: {} }] };
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload([userMessage(marked('ask'))], bareTools));
    const result = send(bp, payload([
      userMessage({ type: 'text', text: 'ask', cache_control: STALE }),
      assistantMessage('working'),
      userMessage(marked('next')),
    ], bareTools));
    expect((result as MarkedPayload).messages[0]?.content[0]?.cache_control).toEqual(STALE);
  });

  it('survives a payload that is not shaped like one', () => {
    const bp = createTrailingCacheBreakpoint();
    expect(() => send(bp, undefined)).not.toThrow();
    expect(() => send(bp, { messages: 'nope' })).not.toThrow();
    expect(() => send(bp, { messages: [] })).not.toThrow();
    expect(() => bp.response(200)).not.toThrow(); // a stray response with no request staged
  });
});

/** A fork child's OPENING request is the one this module could not help before, and the one that needs it
 *  most. The child has no previous request of its own, so nothing is remembered — while the position its
 *  PARENT wrote is now three messages behind pi-ai's mark, because the fork appends the parent's trailing
 *  assistant message, a stand-in result for each open tool call, and its own directive on top of it.
 *
 *  RED BEFORE THE FIX: production fork `brain-ch-subagent-sub-dlg-292aee42` sent exactly this shape and
 *  carried ONE message-level marker, on its directive. Removing the opening-request branch from
 *  `request()` returns this test to `['3']`. */
describe('a fork child’s opening request', () => {
  const DIRECTIVE = buildForkChildMessage('do the thing');
  const placeholder = (id: string): Record<string, unknown> =>
    ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: FORK_PLACEHOLDER_RESULT }] });

  /** The inherited tail, exactly as the seed builds it: the parent's last user message (where the
   *  parent's own mark sat), then its trailing assistant message, then the fork's additions. */
  const forkOpening = (): unknown[] => [
    userMessage(plain('earlier')),
    assistantMessage('earlier reply'),
    userMessage({ type: 'tool_result', tool_use_id: 'a', content: 'parent result' }),
    { role: 'assistant', content: [{ type: 'text', text: 'delegating' }, { type: 'tool_use', id: 'b', name: 'Delegate', input: {} }] },
    userMessage(placeholder('b')),
    userMessage(marked(`<context placement="before-user">\nnow\n</context>\n\n${DIRECTIVE}`)),
  ];

  it('also marks the last message it inherited, which is where its parent’s mark sat', () => {
    const bp = createTrailingCacheBreakpoint();
    expect(markerPositions(send(bp, payload(forkOpening())))).toEqual(['2', '5']);
  });

  it('marks nothing extra on an ordinary session’s first request', () => {
    const bp = createTrailingCacheBreakpoint();
    const ordinary = [userMessage(plain('earlier')), assistantMessage('reply'), userMessage(marked('ask'))];
    expect(markerPositions(send(bp, payload(ordinary)))).toEqual(['2']);
  });

  it('does it once, then hands over to the position it has actually observed', () => {
    const bp = createTrailingCacheBreakpoint();
    send(bp, payload(forkOpening()));
    const next = [...forkOpening()];
    next[5] = userMessage(plain(`<context placement="before-user">\nnow\n</context>\n\n${DIRECTIVE}`));
    next.push(assistantMessage('working'), userMessage(marked('tool done')));
    // The remembered position (the directive, 5) is re-marked; the inherited tail is not marked again.
    expect(markerPositions(send(bp, payload(next)))).toEqual(['5', '7']);
  });

  /** RED BEFORE THE FIX: `request()` spent the opening flag on the way out, so the retry after a 429 took
   *  the ordinary path and marked only pi-ai's own position — the fork then re-cached the entire inherited
   *  prefix over a transient fault. */
  it('still marks the inherited tail when the first attempt failed and is retried', () => {
    const bp = createTrailingCacheBreakpoint();
    expect(markerPositions(send(bp, payload(forkOpening()), 429))).toEqual(['2', '5']);
    expect(markerPositions(send(bp, payload(forkOpening()), 529))).toEqual(['2', '5']);
    expect(markerPositions(send(bp, payload(forkOpening())))).toEqual(['2', '5']);
    // …and the SUCCESSFUL attempt does spend it: the child now has an observation of its own.
    const next = [...forkOpening()];
    next[5] = userMessage(plain(`<context placement="before-user">\nnow\n</context>\n\n${DIRECTIVE}`));
    next.push(assistantMessage('working'), userMessage(marked('tool done')));
    expect(markerPositions(send(bp, payload(next)))).toEqual(['5', '7']);
  });

  it('leaves the four-marker budget intact', () => {
    const bp = createTrailingCacheBreakpoint();
    const spent = { tools: [{ name: 'Read', input_schema: {}, cache_control: EPHEMERAL }, { name: 'Write', input_schema: {}, cache_control: EPHEMERAL }] };
    const result = send(bp, payload(forkOpening(), spent)) as MarkedPayload;
    const total = (result.system ?? []).filter((block) => block.cache_control !== undefined).length
      + (spent.tools.filter((tool) => tool.cache_control !== undefined).length)
      + markerPositions(result).length;
    expect(total).toBeLessThanOrEqual(4);
  });
});
