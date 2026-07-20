import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** Per-conversation state persisted as one JSON file: the chosen model, reasoning/voice/display overrides,
 *  and the conversation "generation" that `/new` bumps to start a fresh session. Shared by every platform
 *  adapter — keyed by that adapter's own conversation id (a Discord channel, a Telegram/WhatsApp chat). */
export class StateStore {
  constructor(file) { this.file = file; this.cache = null; }
  all() {
    if (this.cache) return this.cache;
    try { this.cache = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf-8')) : {}; }
    catch { this.cache = {}; }
    return this.cache;
  }
  get(id) { return this.all()[id] ?? {}; }
  patch(id, fields) {
    const all = this.all();
    all[id] = { ...all[id], ...fields };
    this.cache = all;
    try { writeFileSync(this.file, JSON.stringify(all, null, 2)); } catch { /* best-effort persistence */ }
  }
}
