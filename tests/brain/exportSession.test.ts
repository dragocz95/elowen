import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { exportBrainSession } from '../../src/brain/session/exportSession.js';

/** Exercises Elowen's own self-contained HTML renderer and our JSONL serialization end-to-end from a
 *  seeded store — no live PI session and no PI-internal export module involved. */
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

  it('renders a self-contained HTML transcript with Elowen\'s own renderer (no PI-internal module)', async () => {
    const out = await exportBrainSession({ store, sessionId: 's1', cwd: '/tmp', title: 'Chat about pi', format: 'html' });
    try {
      expect(out.filename).toBe('elowen-chat-about-pi.html');
      expect(out.contentType).toBe('text/html; charset=utf-8');
      const html = readFileSync(out.path, 'utf8');
      expect(html.toLowerCase()).toContain('<!doctype html>');
      // Self-contained: no external asset references (all CSS inline).
      expect(html).not.toMatch(/<(link|script)\b/i);
      // The messages render inline as escaped text under their role labels.
      expect(html).toContain('Chat about pi'); // title
      expect(html).toContain('>You<');
      expect(html).toContain('>Elowen<');
      expect(html).toContain('UNIQUE_QUESTION about deploys');
      expect(html).toContain('UNIQUE_ANSWER ship it');
    } finally { out.cleanup(); }
  });

  it('escapes HTML in message text so a transcript can\'t inject markup', async () => {
    store.appendMessage({ id: 'u2', sessionId: 's1', parentId: null, role: 'user', content: { role: 'user', content: 'raw <script>alert(1)</script> & <b>x</b>' } });
    const out = await exportBrainSession({ store, sessionId: 's1', cwd: '/tmp', title: 'Chat about pi', format: 'html' });
    try {
      const html = readFileSync(out.path, 'utf8');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
    } finally { out.cleanup(); }
  });

  it('includes durable delegated-child status in the HTML transcript', async () => {
    store.appendMessage({
      id: 'a2', sessionId: 's1', parentId: null, role: 'assistant',
      content: { role: 'assistant', content: [{ type: 'toolCall', id: 'delegate-1', name: 'Delegate', arguments: { task: 'inspect' } }] },
    });
    store.createSession({ id: 'brain-ch-subagent-child', userId: 1, model: 'child-model', parentSessionId: 's1' });
    expect(store.upsertSubagentRun('s1', {
      id: 'delegate-1', sessionId: 'brain-ch-subagent-child', status: 'done', task: 'inspect',
      detail: 'finished safely', tools: 3, tokens: 700, seconds: 5, model: 'child-model',
    })).toBe(true);
    const out = await exportBrainSession({ store, sessionId: 's1', cwd: '/tmp', title: 'Chat about pi', format: 'html' });
    try {
      const html = readFileSync(out.path, 'utf8');
      expect(html).toContain('sub-agent · done · 3 tools · 700 tokens · 5s · child-model');
      expect(html).toContain('finished safely');
    } finally { out.cleanup(); }
  });

  it('falls back to the session id when the title has no filename-safe characters', async () => {
    const out = await exportBrainSession({ store, sessionId: 's1', cwd: '/tmp', title: '···', format: 'jsonl' });
    try { expect(out.filename).toBe('elowen-s1.jsonl'); } finally { out.cleanup(); }
  });
});
