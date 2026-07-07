import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** Per-chat state: chosen model + a conversation "generation" (/new bumps it → fresh session). */
export class StateStore {
  constructor(file) { this.file = file; this.cache = null; }
  all() {
    if (this.cache) return this.cache;
    try { this.cache = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf-8')) : {}; }
    catch { this.cache = {}; }
    return this.cache;
  }
  get(chatId) { return this.all()[chatId] ?? {}; }
  patch(chatId, fields) {
    const all = this.all();
    all[chatId] = { ...all[chatId], ...fields };
    this.cache = all;
    try { writeFileSync(this.file, JSON.stringify(all, null, 2)); } catch { /* best-effort persistence */ }
  }
}
