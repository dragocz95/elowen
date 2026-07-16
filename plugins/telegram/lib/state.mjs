import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** Per-chat state: model, reasoning/voice/display overrides + conversation generation. */
export class StateStore {
  constructor(file) { this.file = file; this.cache = null; }
  all() {
    if (this.cache) return this.cache;
    try { this.cache = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf-8')) : {}; }
    catch { this.cache = {}; }
    return this.cache;
  }
  get(channelId) { return this.all()[channelId] ?? {}; }
  patch(channelId, fields) {
    const all = this.all();
    all[channelId] = { ...all[channelId], ...fields };
    this.cache = all;
    try { writeFileSync(this.file, JSON.stringify(all, null, 2)); } catch { /* best-effort persistence */ }
  }
}
