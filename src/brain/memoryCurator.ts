import type { MemoryStore } from '../store/memoryStore.js';
import type { MemoryService } from './memoryService.js';
import type { MemoryCategorizer } from './memoryCategorizer.js';
import type { InferenceClient } from '../inference/types.js';
import type { Logger } from '../shared/logger.js';

/** Upper bound on how many memory mutations one turn's curation may apply. Keeps a single exchange from
 *  rewriting the whole store if the model over-produces. */
const MAX_OPS_PER_TURN = 4;
/** How much of each side of the exchange the extraction prompt sees — a durable fact never needs the
 *  full transcript, and this bounds the relay round-trip. */
const MAX_TEXT_CHARS = 2000;

/** One curator operation as returned by the cheap extraction model. `add` stores a new durable fact
 *  (deduped against near-identical existing memories → update instead); `update`/`delete` address an
 *  existing memory by id; `merge` collapses several ids into one consolidated body. */
interface CuratorOp {
  action: 'add' | 'update' | 'delete' | 'merge';
  id?: number;
  ids?: number[];
  body?: string;
  kind?: string;
  importance?: number;
}

/** Post-turn memory curation: after an owner exchange settles, ask a CHEAP model to distill any durable,
 *  reusable facts and apply them to the user's memory as a small, capped batch. Best-effort by design —
 *  it runs fire-and-forget from BrainService.send() and NEVER throws into the caller: every failure
 *  (no model, relay error, malformed JSON, a bad op) is swallowed and logged. Memory is per-user; the
 *  caller passes the genuine owner's id (owner-chat only), and every mutation is audited as 'agent'. */
export class MemoryCurator {
  private readonly store: MemoryStore;
  private readonly service: MemoryService;
  private readonly inference: () => InferenceClient | null;
  private readonly categorizer?: MemoryCategorizer;
  private readonly logger?: Logger;

  constructor(deps: {
    store: MemoryStore;
    service: MemoryService;
    inference: () => InferenceClient | null;
    /** Optional auto-categorizer: after a genuinely NEW add, best-effort classifies the memory into one
     *  of the owner's categories (fire-and-forget). Absent → new memories are simply left uncategorized. */
    categorizer?: MemoryCategorizer;
    logger?: Logger;
  }) {
    this.store = deps.store;
    this.service = deps.service;
    this.inference = deps.inference;
    this.categorizer = deps.categorizer;
    this.logger = deps.logger;
  }

  /** Distill + persist durable facts from one exchange. Resolves quietly on ANY failure (this is
   *  fire-and-forget); it never rejects, so a `void curator.run(...)` at the call site is safe. */
  async run(userId: number, userText: string, assistantText: string): Promise<void> {
    try {
      const inf = this.inference();
      if (!inf) return; // no memory model configured → no-op (memory still works via the explicit Memory* tools)
      const user = userText.trim();
      if (user === '') return;
      // Show the model the memories it ALREADY holds that are relevant to this exchange, so it can
      // UPDATE/MERGE/skip instead of adding yet another paraphrase of a fact it already knows. The
      // findSimilar guard in applyOne only catches near-identical (≥0.85 cosine); this catches the
      // "same point, different wording" redundancy (e.g. "Alex" vs "Alex Kim, the operator").
      let existing: { id: number; body: string }[] = [];
      try {
        // searchSemantic (NOT retrieve): the curator is BROWSING what's already stored to avoid
        // paraphrase duplicates — it must not markUsed, or every curated turn would silently inflate
        // use_count/last_used_at on tangentially-related memories and skew future recall ranking.
        const rows = await this.service.searchSemantic(userId, `${user}\n${assistantText}`, 8);
        existing = rows.map((m) => ({ id: m.id, body: m.body }));
      } catch { /* retrieval is best-effort — fall back to a blind curation pass */ }
      const { text } = await inf.decide(buildPrompt(user, assistantText, existing));
      const ops = parseOps(text);
      if (ops.length === 0) return; // model ran but distilled nothing durable this turn — expected + quiet
      // Record WHICH model distilled these facts on every add/update audit row.
      await this.apply(userId, ops.slice(0, MAX_OPS_PER_TURN), inf.model);
      this.logger?.info('memory curator applied memory op(s)', { userId, ops: Math.min(ops.length, MAX_OPS_PER_TURN), model: inf.model });
    } catch (err) {
      this.logger?.warn('memory curator failed', { userId, error: String(err) });
    }
  }

  /** Apply the capped op batch. Each op is independent — a single bad op is logged and skipped, never
   *  aborting the rest. `add` first checks findSimilar so a near-duplicate becomes an update, not a
   *  fresh row. Every mutation is audited as the agent. */
  private async apply(userId: number, ops: CuratorOp[], model: string): Promise<void> {
    for (const op of ops) {
      try {
        await this.applyOne(userId, op, model);
      } catch (err) {
        this.logger?.warn('memory curator op failed', { userId, action: op.action, error: String(err) });
      }
    }
  }

  private async applyOne(userId: number, op: CuratorOp, model: string): Promise<void> {
    switch (op.action) {
      case 'add': {
        const body = (op.body ?? '').trim();
        if (body === '') return;
        // Prefer updating a near-duplicate over piling on a paraphrase.
        const near = await this.service.findSimilar(userId, body);
        if (near.length > 0) {
          this.store.update(userId, near[0]!.memory.id, { body, kind: op.kind, importance: op.importance },
            'agent', 'curator: refreshed near-duplicate', model);
          return;
        }
        const row = this.store.add(userId, { body, kind: op.kind, importance: op.importance, source: 'agent' },
          'agent', 'curator: new durable fact', model);
        // Fire-and-forget auto-categorization of the NEW memory only (not the near-duplicate refresh
        // above). classifyMemory already swallows+logs every failure; the .catch is belt-and-suspenders
        // so it never rejects into the op batch.
        if (this.categorizer) void this.categorizer.classifyMemory(userId, row.id, 'agent').catch(() => { /* best-effort */ });
        return;
      }
      case 'update': {
        if (op.id === undefined) return;
        const body = op.body?.trim();
        this.store.update(userId, op.id,
          { body: body === '' ? undefined : body, kind: op.kind, importance: op.importance },
          'agent', 'curator: revised fact', model);
        return;
      }
      case 'delete': {
        if (op.id === undefined) return;
        this.store.softDelete(userId, op.id, 'agent', 'curator: obsolete fact');
        return;
      }
      case 'merge': {
        const ids = op.ids ?? [];
        const body = (op.body ?? '').trim();
        if (ids.length === 0 || body === '') return;
        this.store.merge(userId, ids, body, 'agent', 'curator: consolidated facts');
        return;
      }
    }
  }
}

/** The extraction prompt, modeled on mem0's fact-retrieval + update prompts: user-anchored facts only,
 *  strict source rules (the assistant's reply is NOT a knowledge source), few-shot calibration with
 *  empty-output examples, date grounding — the cheap model otherwise "helps" by saving trivia from the
 *  assistant's explanations. Output contract unchanged (JSON array of ops, parseOps). */
function buildPrompt(userText: string, assistantText: string, existing: { id: number; body: string }[] = []): string {
  const u = userText.slice(0, MAX_TEXT_CHARS);
  const a = assistantText.slice(0, MAX_TEXT_CHARS);
  const knownBlock = existing.length
    ? [
        '',
        'ALREADY-STORED relevant memories (id — text):',
        ...existing.map((m) => `#${m.id} — ${m.body}`),
        'ANTI-DUPLICATION RULE: if a new point is already covered by one of these, do NOT add a paraphrase.',
        'Instead "update" the closest one (more precise/complete wording), or "merge" several into one. Only',
        '"add" facts that are NOT already among the stored ones. Never keep two memories with the same meaning.',
        'If a new fact CONTRADICTS a stored memory, "update" it (or "delete" it if it is simply no longer true).',
      ]
    : [];
  return [
    'You are the long-term memory curator for the assistant Elowen. Below is ONE exchange (one user message',
    'and the assistant\'s reply). Extract durable, reusable facts ABOUT THE USER worth remembering in',
    `future sessions, and emit memory operations. Today's date is ${new Date().toISOString().slice(0, 10)}.`,
    '',
    'WHAT TO EXTRACT (each fact must be anchored to the user or their projects):',
    '- Stable preferences and working style (tools, stack, formatting, how they like answers)',
    '- Decisions the user made or approved ("User decided to use pnpm for project X")',
    '- Personal/professional details the user shared (name, role, people, recurring commitments)',
    '- Plans, goals and intentions the user stated',
    '- The user\'s project architecture and infrastructure AS THE USER HAS IT (exact paths, endpoints,',
    '  ports, hostnames, commands — verbatim)',
    '- Non-obvious gotchas discovered in the user\'s environment that will bite again',
    '',
    'SOURCE RULES:',
    '- The USER\'s message is the primary source of facts.',
    '- From the ASSISTANT\'s reply, extract ONLY: (a) durable outcomes of work done for the user this turn',
    '  that they will rely on later, and (b) specific recommendations or decisions the user accepted.',
    '  Frame them from the user\'s side ("User\'s daemon listens on :4400").',
    '- NEVER extract general knowledge, explanations, definitions, tutorials or trivia from the',
    '  assistant\'s reply. If the assistant explained how something works, that is NOT a memory.',
    '- Never store the same fact twice because the assistant echoed the user\'s own words back.',
    '',
    'DO NOT STORE:',
    '- Greetings, chit-chat, thanks, small talk',
    '- Transient state ("X is running", "not committed yet", "still debugging")',
    '- One-off debug steps, error messages, or the mechanics of this conversation',
    '- Meta-descriptions ("User asked about X", "Assistant explained Y", "Assistant fixed a bug") —',
    '  store the resulting durable fact or decision itself, or nothing',
    '- General world/technical knowledge that is not specific to this user',
    '',
    'EACH `body` MUST BE:',
    '- Self-contained and understandable alone: name the subject ("User …", "Project <name> …"),',
    '  no bare pronouns',
    '- In the USER\'S OWN language (match the language of the exchange)',
    '- Concrete: keep names, paths, ports, versions and commands exactly as written; resolve relative',
    '  dates ("tomorrow") to absolute dates using today\'s date',
    '',
    'Examples (calibration only — never copy their content):',
    'User: "Hi, how are you?" / Assistant: "Great, thanks!"',
    '-> []',
    'User: "How do JWT refresh tokens work?" / Assistant: <explanation of JWT>',
    '-> []   (general knowledge, nothing about the user)',
    'User: "Fix that failing test." / Assistant: "Done, the mock was stale."',
    '-> []   (one-off debug, nothing durable)',
    'User: "My name is Filip, I prefer short answers." / Assistant: "Noted, Filip!"',
    '-> [{"action":"add","body":"User\'s name is Filip; prefers short answers.","kind":"preference","importance":4}]',
    'User: "Switch the project to pnpm, npm eats too much disk." / Assistant: "Done — project now uses pnpm."',
    '-> [{"action":"add","body":"Project uses pnpm instead of npm (user\'s decision, disk usage).","kind":"decision","importance":3}]',
    '',
    'An empty array [] is the EXPECTED output for most exchanges. When in doubt, return [].',
    '',
    `Return ONLY a JSON array, at most ${MAX_OPS_PER_TURN} operations, with no other text. Format per operation:`,
    '{"action":"add","body":"<self-contained fact, in the user\'s language>","kind":"fact|preference|decision","importance":1-5}',
    '{"action":"update","id":<id>,"body":"<new text>"}',
    '{"action":"delete","id":<id>}',
    '{"action":"merge","ids":[<id>,...],"body":"<merged fact>"}',
    ...knownBlock,
    '',
    `User: ${u}`,
    '',
    `Assistant: ${a}`,
  ].join('\n');
}

/** Parse the model's reply into ops. Tolerates a ```json fence or surrounding prose by extracting the
 *  first JSON array. Returns [] on anything unparseable — the curator degrades to "nothing to do". */
function parseOps(text: string): CuratorOp[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const ops: CuratorOp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const action = o.action;
    if (action !== 'add' && action !== 'update' && action !== 'delete' && action !== 'merge') continue;
    ops.push({
      action,
      id: typeof o.id === 'number' ? o.id : undefined,
      ids: Array.isArray(o.ids) ? o.ids.filter((x): x is number => typeof x === 'number') : undefined,
      body: typeof o.body === 'string' ? o.body : undefined,
      kind: typeof o.kind === 'string' ? o.kind : undefined,
      importance: typeof o.importance === 'number' ? o.importance : undefined,
    });
  }
  return ops;
}
