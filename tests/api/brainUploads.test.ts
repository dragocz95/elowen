import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestApp } from '../helpers/testApp.js';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'elowen-upload-route-'));
}

async function upload(app: Awaited<ReturnType<typeof makeTestApp>>['app'], token: string, name: string, body: string) {
  return app.request(`/brain/uploads?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body,
  });
}

describe('POST /brain/uploads', () => {
  it('streams the body into the caller’s project and reports where it went', async () => {
    const dir = workspace();
    try {
      const { app, token, deps } = await makeTestApp();
      deps.projects.update(1, { path: dir });

      const res = await upload(app, token, 'nabídka.pdf', 'PDF-BYTES');
      expect(res.status).toBe(200);
      const body = await res.json() as { path: string; relative: string; name: string; size: number; project: { id: number } };

      expect(body.name).toBe('nabídka.pdf');
      expect(body.project.id).toBe(1);
      expect(body.path.startsWith(dir)).toBe(true);
      expect(body.relative.startsWith(join('uploads', 'admin'))).toBe(true);
      // The bytes really landed — a route that reports a path without writing it would send the agent
      // to read a file that is not there.
      expect(readFileSync(body.path, 'utf8')).toBe('PDF-BYTES');
      expect(body.size).toBe('PDF-BYTES'.length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('cannot be walked out of the project by the file name', async () => {
    const dir = workspace();
    try {
      const { app, token, deps } = await makeTestApp();
      deps.projects.update(1, { path: dir });

      const res = await upload(app, token, '../../../../../../tmp/elowen-owned.sh', 'x');
      expect(res.status).toBe(200);
      const body = await res.json() as { path: string; name: string };
      expect(body.name).toBe('elowen-owned.sh');
      expect(body.path.startsWith(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never overwrites a file somebody else already put there', async () => {
    const dir = workspace();
    try {
      const { app, token, deps } = await makeTestApp();
      deps.projects.update(1, { path: dir });

      const first = await (await upload(app, token, 'report.txt', 'first')).json() as { path: string };
      const second = await (await upload(app, token, 'report.txt', 'second')).json() as { path: string; name: string };

      expect(second.name).toBe('report (2).txt');
      expect(readFileSync(first.path, 'utf8')).toBe('first');
      expect(readFileSync(second.path, 'utf8')).toBe('second');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an account that has no project, and says what to do about it', async () => {
    // The gate that matters: a member is confined to the projects they were assigned, so an account
    // with none has nowhere legitimate to write and must not fall back to somebody else's project.
    const { app, deps } = await makeTestApp({ userProjects: true });
    const outsider = deps.users.create('outsider', 'pw');
    const outsiderToken = deps.users.issueToken(outsider.id);

    const res = await upload(app, outsiderToken, 'x.txt', 'x');
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/ask an administrator to assign you one/);
  });

  it('rejects a request with no body rather than creating an empty file', async () => {
    const dir = workspace();
    try {
      const { app, token, deps } = await makeTestApp();
      deps.projects.update(1, { path: dir });
      const res = await app.request('/brain/uploads?name=x.txt', {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
