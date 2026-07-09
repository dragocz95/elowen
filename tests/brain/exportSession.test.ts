import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { exportBrainSession } from '../../src/brain/session/exportSession.js';

/** Exercises the real PI exporter (imported off its internal export-html module) and our JSONL
 *  serialization end-to-end from a seeded store — no live PI session involved. */
describe('exportBrainSession', () => {
  let store: BrainStore;
  beforeEach(() => {
    store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 's1', userId: 1, title: 'Chat about pi', model: 'm' });
    store.appendMessage({ id: 'u1', sessionId: 's1', parentId: null, role: 'user', content: { role: 'user', content: 'UNIQUE_QUESTION about deploys' } });
    store.appendMessage({ id: 'a1', sessionId: 's1', parentId: null, role: 'assistant', content: { role: 'assistant', content: 'UNIQUE_ANSWER ship it' } });
  });

  it('produces a JSONL session file (header + one entry per stored message)', async () => {
    const out = await exportBrainSession({ store, sessionId: 's1', cwd: '/tmp', title: 'Chat about pi', format: 'jsonl' });
    try {
      expect(out.filename).toBe('elowen-chat-about-pi.jsonl');
      expect(out.contentType).toBe('application/x-ndjson');
      const lines = readFileSync(out.path, 'utf8').trim().split('\n');
      const header = JSON.parse(lines[0]!) as { type: string; version: number; id: string };
      expect(header.type).toBe('session');
      expect(lines).toHaveLength(3); // header + 2 messages
      const first = JSON.parse(lines[1]!) as { type: string; parentId: null; message: { content: string } };
      expect(first.parentId).toBeNull();
      expect(first.message.content).toContain('UNIQUE_QUESTION');
      const second = JSON.parse(lines[2]!) as { parentId: string; message: { content: string } };
      expect(second.parentId).toBe(JSON.parse(lines[1]!).id); // re-chained into a linear parent chain
      expect(second.message.content).toContain('UNIQUE_ANSWER');
    } finally { out.cleanup(); }
  });

  it('renders a self-contained HTML transcript through PI\'s own exporter', async () => {
    const out = await exportBrainSession({ store, sessionId: 's1', cwd: '/tmp', title: 'Chat about pi', format: 'html' });
    try {
      expect(out.filename).toBe('elowen-chat-about-pi.html');
      expect(out.contentType).toBe('text/html; charset=utf-8');
      const html = readFileSync(out.path, 'utf8');
      expect(html).toContain('<!DOCTYPE html>');
      // PI base64-encodes the session data into a <script> tag — decode it and confirm our messages rode through.
      const m = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html);
      expect(m).not.toBeNull();
      const decoded = Buffer.from(m![1]!, 'base64').toString('utf8');
      expect(decoded).toContain('UNIQUE_QUESTION');
      expect(decoded).toContain('UNIQUE_ANSWER');
    } finally { out.cleanup(); }
  });

  it('falls back to the session id when the title has no filename-safe characters', async () => {
    const out = await exportBrainSession({ store, sessionId: 's1', cwd: '/tmp', title: '···', format: 'jsonl' });
    try { expect(out.filename).toBe('elowen-s1.jsonl'); } finally { out.cleanup(); }
  });
});
