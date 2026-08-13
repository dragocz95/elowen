// The ambient GET endpoints the app shell polls on mount (sidebars, config, project list). The shell
// throws if any are missing, so all are answered with canned lists — mostly empty, which is a valid,
// quiet state.
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { config, sessions, tasks, missions, projects } from '../../seed/fixtures.ts';
import { getResponse } from '../overrides.ts';

export function registerCoreRoutes(app: Hono): void {
  // Playwright's webServer readiness probe hits this (never overridable).
  app.get('/health', (c) => c.json({ ok: true, version: 'e2e-fake' }));

  // The app shell opens a global `/events` SSE (useElowenEvents) for cache-invalidation pushes. It must
  // be a real `text/event-stream` or the browser EventSource aborts on the wrong MIME type and retries in
  // a loop (console-error noise that also fails the clean-console smoke). The harness never needs to push
  // ambient events, so this just holds the connection open with heartbeats.
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      await stream.write(': connected\n\n');
      while (!c.req.raw.signal.aborted) {
        await stream.sleep(15000);
        if (c.req.raw.signal.aborted) break;
        await stream.write(': ping\n\n');
      }
    }),
  );

  app.get('/config', (c) => c.json(getResponse('config', config)));
  app.get('/sessions', (c) => c.json(getResponse('sessions', sessions)));
  app.get('/tasks', (c) => c.json(getResponse('tasks', tasks)));
  app.get('/tasks/ready', (c) => c.json(getResponse('tasks/ready', tasks)));
  app.get('/missions', (c) => c.json(getResponse('missions', missions)));
  app.get('/projects', (c) => c.json(getResponse('projects', projects)));
}
