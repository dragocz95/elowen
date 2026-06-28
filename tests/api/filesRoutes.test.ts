import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';

// Open mode (no UserStore) so canAccessProject always passes — the focus here is the file-editor
// behaviour, not the tenancy gate (covered in projectAccess.test.ts). The project points at a real
// temp dir so every operation hits the actual filesystem.
function makeApp() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const projects = new ProjectStore(db);
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
    bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), projects,
  });
  return { app, projects };
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('project file editor routes', () => {
  let root: string;
  let app: ReturnType<typeof makeApp>['app'];
  let id: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-files-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/index.ts'), 'export const hello = 1;\n');
    writeFileSync(join(root, 'README.md'), '# project\n');
    const made = makeApp();
    app = made.app;
    // Register the temp dir as a project and capture its id for the routes below.
    id = (await (await app.request('/projects', json({ slug: 'tmp', path: root }))).json()).id;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('GET /files lists the tree (dirs first, VCS noise skipped)', async () => {
    mkdirSync(join(root, '.git'), { recursive: true }); // must be ignored by the walker
    const tree = await (await app.request(`/projects/${id}/files`)).json() as { path: string; type: string }[];
    const paths = tree.map((n) => n.path);
    expect(paths).toContain('src');
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('README.md');
    expect(paths).not.toContain('.git');
  });

  it('GET /file reads UTF-8 content; missing path is 400', async () => {
    const res = await app.request(`/projects/${id}/file?path=${encodeURIComponent('src/index.ts')}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: 'export const hello = 1;\n', truncated: false });
    expect((await app.request(`/projects/${id}/file`)).status).toBe(400); // no ?path
  });

  it('PUT /file writes content that reads back, and creates parent dirs', async () => {
    const w = await app.request(`/projects/${id}/file`, put({ path: 'src/new/deep.ts', content: 'export const x = 2;\n' }));
    expect(w.status).toBe(200);
    expect(readFileSync(join(root, 'src/new/deep.ts'), 'utf8')).toBe('export const x = 2;\n');
    const back = await (await app.request(`/projects/${id}/file?path=${encodeURIComponent('src/new/deep.ts')}`)).json();
    expect(back.content).toBe('export const x = 2;\n');
  });

  it('PUT /file rejects a missing field (400) and a traversal path (400), writing nothing', async () => {
    expect((await app.request(`/projects/${id}/file`, put({ path: 'a.ts' }))).status).toBe(400); // no content
    const bad = await app.request(`/projects/${id}/file`, put({ path: '../escape.ts', content: 'x' }));
    expect(bad.status).toBe(400);
    expect(existsSync(join(root, '../escape.ts'))).toBe(false);
  });

  it('POST /new-file and POST /dir create entries inside the root', async () => {
    expect((await app.request(`/projects/${id}/new-file`, json({ path: 'docs/notes.md' }))).status).toBe(200);
    expect(existsSync(join(root, 'docs/notes.md'))).toBe(true);
    expect((await app.request(`/projects/${id}/dir`, json({ path: 'docs/sub' }))).status).toBe(200);
    expect(existsSync(join(root, 'docs/sub'))).toBe(true);
    expect((await app.request(`/projects/${id}/new-file`, json({}))).status).toBe(400); // path required
  });

  it('POST /rename moves an entry; POST /copy duplicates it', async () => {
    const r = await app.request(`/projects/${id}/rename`, json({ from: 'README.md', to: 'READTHIS.md' }));
    expect(r.status).toBe(200);
    expect(existsSync(join(root, 'README.md'))).toBe(false);
    expect(existsSync(join(root, 'READTHIS.md'))).toBe(true);
    const cp = await app.request(`/projects/${id}/copy`, json({ from: 'src/index.ts', to: 'src/index.copy.ts' }));
    expect(cp.status).toBe(200);
    expect(existsSync(join(root, 'src/index.ts'))).toBe(true);
    expect(readFileSync(join(root, 'src/index.copy.ts'), 'utf8')).toBe('export const hello = 1;\n');
    expect((await app.request(`/projects/${id}/rename`, json({ from: 'README.md' }))).status).toBe(400); // to required
  });

  it('DELETE /entry removes a file inside the root; missing path is 400', async () => {
    expect((await app.request(`/projects/${id}/entry?path=${encodeURIComponent('src/index.ts')}`, { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(join(root, 'src/index.ts'))).toBe(false);
    expect((await app.request(`/projects/${id}/entry`, { method: 'DELETE' })).status).toBe(400);
  });

  it('GET /raw serves image bytes by extension; a non-file (dir) is 415', async () => {
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    const ok = await app.request(`/projects/${id}/raw?path=${encodeURIComponent('logo.png')}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await ok.arrayBuffer())[0]).toBe(0x89);
    // An unknown extension still serves bytes, but as a generic octet-stream.
    const txt = await app.request(`/projects/${id}/raw?path=${encodeURIComponent('README.md')}`);
    expect(txt.status).toBe(200);
    expect(txt.headers.get('content-type')).toBe('application/octet-stream');
    // A directory isn't a regular file → not previewable → 415.
    const dir = await app.request(`/projects/${id}/raw?path=${encodeURIComponent('src')}`);
    expect(dir.status).toBe(415);
  });

  it('returns 404 for file ops on an unknown project', async () => {
    expect((await app.request('/projects/999/files')).status).toBe(404);
    expect((await app.request('/projects/999/file', put({ path: 'a', content: 'b' }))).status).toBe(404);
  });
});
