import { readJsonSafe, writeJsonAtomic } from './atomicJson.mjs';

/** Per-conversation state persisted as one JSON file: the chosen model, reasoning/voice/display overrides,
 *  and the conversation "generation" that `/new` bumps to start a fresh session. Shared by every platform
 *  adapter — keyed by that adapter's own conversation id (a Discord channel, a Telegram/WhatsApp chat).
 *
 *  Writes go through a temp file + atomic rename (see atomicJson.mjs), so an interrupted write can never
 *  corrupt the file or lose the previous good state. A write failure is LOGGED and RE-THROWN — `patch()`
 *  must not report success (and silently drop the change on the next restart) when it didn't actually
 *  persist; the caller (a /model, /display, /voice or /new command handler) is expected to let that
 *  failure reach the user instead of confirming a change that never stuck. */
export class StateStore {
  constructor(file, logger = console) { this.file = file; this.cache = null; this.logger = logger; }
  all() {
    if (this.cache) return this.cache;
    this.cache = readJsonSafe(this.file, {}, (e) =>
      this.logger?.error?.(`stateStore: corrupt state file ${this.file} — treating as empty: ${e?.message ?? e}`));
    return this.cache;
  }
  get(id) { return this.all()[id] ?? {}; }
  patch(id, fields) {
    const all = this.all();
    const next = { ...all, [id]: { ...all[id], ...fields } };
    try {
      writeJsonAtomic(this.file, next);
    } catch (e) {
      this.logger?.error?.(`stateStore: failed to persist ${this.file}: ${e?.message ?? e}`);
      throw e;
    }
    this.cache = next;
  }
}
