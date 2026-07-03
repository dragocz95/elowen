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
      if (!inf) return; // no curator model configured → no-op (memory still works, just no auto-extraction)
      const user = userText.trim();
      if (user === '') return;
      const { text } = await inf.decide(buildPrompt(user, assistantText));
      const ops = parseOps(text);
      if (ops.length === 0) return;
      await this.apply(userId, ops.slice(0, MAX_OPS_PER_TURN));
    } catch (err) {
      this.logger?.warn('memory curator failed', { userId, error: String(err) });
    }
  }

  /** Apply the capped op batch. Each op is independent — a single bad op is logged and skipped, never
   *  aborting the rest. `add` first checks findSimilar so a near-duplicate becomes an update, not a
   *  fresh row. Every mutation is audited as the agent. */
  private async apply(userId: number, ops: CuratorOp[]): Promise<void> {
    for (const op of ops) {
      try {
        await this.applyOne(userId, op);
      } catch (err) {
        this.logger?.warn('memory curator op failed', { userId, action: op.action, error: String(err) });
      }
    }
  }

  private async applyOne(userId: number, op: CuratorOp): Promise<void> {
    switch (op.action) {
      case 'add': {
        const body = (op.body ?? '').trim();
        if (body === '') return;
        // Prefer updating a near-duplicate over piling on a paraphrase.
        const near = await this.service.findSimilar(userId, body);
        if (near.length > 0) {
          this.store.update(userId, near[0]!.memory.id, { body, kind: op.kind, importance: op.importance },
            'agent', 'curator: refreshed near-duplicate');
          return;
        }
        const row = this.store.add(userId, { body, kind: op.kind, importance: op.importance, source: 'agent' },
          'agent', 'curator: new durable fact');
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
          'agent', 'curator: revised fact');
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

/** The extraction prompt: durable facts only, Czech-friendly, strict JSON, capped op count. Kept tight
 *  so the cheap model returns a small batch (or an empty array when nothing is worth remembering). */
function buildPrompt(userText: string, assistantText: string): string {
  const u = userText.slice(0, MAX_TEXT_CHARS);
  const a = assistantText.slice(0, MAX_TEXT_CHARS);
  return [
    'Jsi kurátor dlouhodobé paměti asistenta Orca. Z JEDNÉ výměny níže vytáhni POUZE trvalé, znovu',
    'použitelné fakty o uživateli: stabilní preference a pracovní styl, rozhodnutí, architektura',
    'projektů, infrastruktura (cesty, endpointy, porty), netriviální gotchas.',
    'NEUKLÁDEJ: pozdravy, chit-chat, přechodný stav, jednorázové debug kroky, ani nic zjevného.',
    'Když nic trvalého nevzniklo, vrať prázdné pole [].',
    '',
    `Vrať POUZE JSON pole, max ${MAX_OPS_PER_TURN} operací, bez dalšího textu. Formát každé operace:`,
    '{"action":"add","body":"<fakt, samostatný, česky>","kind":"fact|preference|decision","importance":1-5}',
    '{"action":"update","id":<id>,"body":"<nový text>"}',
    '{"action":"delete","id":<id>}',
    '{"action":"merge","ids":[<id>,...],"body":"<sloučený fakt>"}',
    '',
    `Uživatel: ${u}`,
    '',
    `Asistent: ${a}`,
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
