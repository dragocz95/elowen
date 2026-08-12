import type { PluginApiRequest, PluginContext, PluginHttpResponse } from '../../../src/plugins/api.js';
import {
  copyProjectEntry, createProjectDir, createProjectFile, deleteProjectEntry, listProjectFiles,
  projectChangedFiles, projectCommitDiff, projectCommitFileDiff, projectCommitFiles, projectCommitLog,
  projectFileAtHead, projectFileDiff, projectWorkingDiff, readProjectBytes, readProjectFile,
  renameProjectEntry, writeProjectFile,
} from './files.js';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif' };

function projectFor(ctx: PluginContext, req: PluginApiRequest): { path: string } | PluginHttpResponse {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return { status: 404, body: { error: 'project not found' } };
  if (req.auth.accessibleProjects !== null && !req.auth.accessibleProjects.includes(id)) return { status: 403, body: { error: 'forbidden' } };
  const project = ctx.host.stores().projects.get(id);
  return project ? project : { status: 404, body: { error: 'project not found' } };
}
function isResponse(value: { path: string } | PluginHttpResponse): value is PluginHttpResponse { return !('path' in value); }
async function body(req: PluginApiRequest): Promise<Record<string, unknown> | null> {
  const value = await req.json<unknown>().catch(() => null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function requiredString(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null; }
function fileError(error: unknown): PluginHttpResponse { return { status: 400, body: { error: error instanceof Error ? error.message : 'invalid path' } }; }

export function registerEditorApi(ctx: PluginContext): void {
  const safe = ctx.host.projectFiles().safe;
  const route = (rootMount: string, method: string, handler: (req: PluginApiRequest, project: { path: string }) => Promise<PluginHttpResponse> | PluginHttpResponse) => {
    ctx.registerApiRoute({ rootMount, path: '', method, access: 'user', handler: async (req) => {
      if (req.path !== '') return { status: 404, body: { error: 'not found' } };
      const project = projectFor(ctx, req);
      return isResponse(project) ? project : handler(req, project);
    } });
  };
  route('/projects/:id/files', 'GET', (_req, project) => ({ body: listProjectFiles(project.path) }));
  route('/projects/:id/file', 'GET', (req, project) => {
    const path = requiredString(req.query.path); if (!path) return { status: 400, body: { error: 'path required' } };
    try { return { body: readProjectFile(safe, project.path, path) }; } catch (error) { return fileError(error); }
  });
  route('/projects/:id/file', 'PUT', async (req, project) => {
    const input = await body(req); const path = requiredString(input?.path); const content = typeof input?.content === 'string' ? input.content : null;
    if (!path || content === null) return { status: 400, body: { error: 'path and content required' } };
    try { writeProjectFile(safe, project.path, path, content); return { body: { ok: true } }; } catch (error) { return fileError(error); }
  });
  route('/projects/:id/raw', 'GET', (req, project) => {
    const path = requiredString(req.query.path); if (!path) return { status: 400, body: { error: 'path required' } };
    try {
      const bytes = readProjectBytes(safe, project.path, path); if (!bytes) return { status: 415, body: { error: 'not previewable' } };
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      return { body: new Uint8Array(bytes), headers: { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' } };
    } catch (error) { return fileError(error); }
  });
  const onePath = (rootMount: string, operation: (projectPath: string, path: string) => Promise<unknown> | unknown, field: string) => route(rootMount, 'GET', async (req, project) => {
    const path = requiredString(req.query.path); if (!path) return { status: 400, body: { error: 'path required' } };
    try { return { body: { [field]: await operation(project.path, path) } }; } catch (error) { return fileError(error); }
  });
  route('/projects/:id/new-file', 'POST', async (req, project) => { const input = await body(req); const path = requiredString(input?.path); if (!path) return { status: 400, body: { error: 'path required' } }; try { createProjectFile(safe, project.path, path); return { body: { ok: true } }; } catch (error) { return fileError(error); } });
  route('/projects/:id/dir', 'POST', async (req, project) => { const input = await body(req); const path = requiredString(input?.path); if (!path) return { status: 400, body: { error: 'path required' } }; try { createProjectDir(safe, project.path, path); return { body: { ok: true } }; } catch (error) { return fileError(error); } });
  for (const [mount, operation] of [['/projects/:id/rename', renameProjectEntry], ['/projects/:id/copy', copyProjectEntry]] as const) route(mount, 'POST', async (req, project) => { const input = await body(req); const from = requiredString(input?.from); const to = requiredString(input?.to); if (!from || !to) return { status: 400, body: { error: 'from and to required' } }; try { operation(safe, project.path, from, to); return { body: { ok: true } }; } catch (error) { return fileError(error); } });
  route('/projects/:id/entry', 'DELETE', (req, project) => { const path = requiredString(req.query.path); if (!path) return { status: 400, body: { error: 'path required' } }; try { deleteProjectEntry(safe, project.path, path); return { body: { ok: true } }; } catch (error) { return fileError(error); } });
  onePath('/projects/:id/diff', (root, path) => projectFileDiff(safe, root, path), 'diff');
  onePath('/projects/:id/head', (root, path) => projectFileAtHead(safe, root, path), 'content');
  route('/projects/:id/commit/:hash', 'GET', async (req, project) => ({ body: { diff: await projectCommitDiff(project.path, req.params.hash ?? ''), files: await projectCommitFiles(project.path, req.params.hash ?? '') } }));
  route('/projects/:id/commit/:hash/diff', 'GET', async (req, project) => { const path = requiredString(req.query.path); if (!path) return { status: 400, body: { error: 'path required' } }; try { return { body: { diff: await projectCommitFileDiff(safe, project.path, req.params.hash ?? '', path) } }; } catch (error) { return fileError(error); } });
  route('/projects/:id/commits', 'GET', async (req, project) => { const parsed = Number(req.query.limit); return { body: { commits: await projectCommitLog(project.path, Number.isFinite(parsed) ? parsed : 30) } }; });
  route('/projects/:id/changed', 'GET', async (_req, project) => ({ body: { changed: await projectChangedFiles(project.path) } }));
  route('/projects/:id/changes', 'GET', async (_req, project) => ({ body: { diff: await projectWorkingDiff(project.path) } }));
}
