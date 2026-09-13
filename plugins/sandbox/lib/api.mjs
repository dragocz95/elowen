import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { activeExecutionLeases, withRepoLease } from './db.mjs';
import { bubblewrapProbe, directorySize, ensureUserHome, resetUserHome, runPrepared } from './execution.mjs';

const json = (body, status = 200) => ({ status, body });
const errorResponse = (error) => json({
  error: error?.code || 'sandbox_error',
  detail: error instanceof Error ? error.message : String(error),
}, Number(error?.status) || 500);

async function body(req) {
  const parsed = await req.json();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error('JSON object body required'), { code: 'invalid_body', status: 400 });
  return parsed;
}

function requireTargetUser(req, stores) {
  const userId = Number(req.query.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw Object.assign(new Error('a valid target userId is required'), { code: 'invalid_user', status: 400 });
  if (!stores.usersRead.list().some((user) => user.id === userId)) throw Object.assign(new Error('target user not found'), { code: 'user_not_found', status: 404 });
  return userId;
}

export function registerSandboxApi({ ctx, db, dataDir, execution, migrationState }) {
  const stores = ctx.host.stores();
  const register = (path, method, handler, access = 'user') => ctx.registerApiRoute({
    path, method, access,
    handler: async (req) => {
      try { return await handler(req); }
      catch (error) { return errorResponse(error); }
    },
  });

  const gitConfig = async (userId, args, allowFailure = false) => {
    const { home } = ensureUserHome(dataDir, userId);
    const prepared = await execution.prepare({ command: { type: 'argv', file: 'git', args: ['config', '--file', join(home, '.gitconfig'), ...args] }, cwd: home, leaseKind: 'terminal' }, { roots: [home], accountUserId: userId });
    return runPrepared(prepared, { allowFailure, outputCap: 64_000 });
  };

  const readAuthor = async (userId) => {
    const name = await gitConfig(userId, ['--get', 'user.name'], true);
    const email = await gitConfig(userId, ['--get', 'user.email'], true);
    return { name: name.code === 0 ? name.output.trim() : '', email: email.code === 0 ? email.output.trim() : '' };
  };

  const environmentState = async (userId) => {
    const homeState = ensureUserHome(dataDir, userId);
    const probe = bubblewrapProbe();
    const operator = stores.usersRead.isAdmin(userId);
    const mode = operator || ctx.config.confineNonOperators === false ? 'direct' : probe.available ? 'confined' : 'unavailable';
    const size = directorySize(homeState.home);
    const author = await readAuthor(userId);
    const leases = activeExecutionLeases(db, { accountUserId: userId, homeGeneration: homeState.generation });
    return {
      mode,
      probe,
      networkAvailable: mode === 'confined',
      home: { path: homeState.home, generation: homeState.generation, ...size, activeProcesses: leases.length },
      author,
      migrationCollision: migrationState.collisions.some((collision) => collision.userId === userId),
    };
  };

  register('environment', 'GET', async (req) => json(await environmentState(requireTargetUser(req, stores))), 'admin');

  register('environment/author', 'POST', async (req) => {
    const userId = requireTargetUser(req, stores);
    const input = await body(req);
    const name = String(input.name ?? '').trim();
    const email = String(input.email ?? '').trim();
    if (!name || name.length > 120) throw Object.assign(new Error('Git author name must be 1-120 characters'), { code: 'invalid_author_name', status: 400 });
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw Object.assign(new Error('a valid Git author email is required'), { code: 'invalid_author_email', status: 400 });
    await gitConfig(userId, ['user.name', name]);
    await gitConfig(userId, ['user.email', email]);
    return json({ author: { name, email } });
  }, 'admin');

  register('environment/reset-preview', 'POST', async (req) => {
    const userId = requireTargetUser(req, stores);
    const state = await environmentState(userId);
    const phrase = 'RESET HOME';
    const payload = {
      generation: state.home.generation,
      bytes: state.home.bytes,
      entries: state.home.entries,
      activeProcesses: state.home.activeProcesses,
      author: state.author,
    };
    const previewHash = createHash('sha256').update(JSON.stringify({ userId, ...payload })).digest('hex');
    return json({ ...payload, phrase, previewHash });
  }, 'admin');

  register('environment/reset', 'POST', async (req) => {
    const userId = requireTargetUser(req, stores);
    const input = await body(req);
    const state = await environmentState(userId);
    const payload = {
      generation: state.home.generation,
      bytes: state.home.bytes,
      entries: state.home.entries,
      activeProcesses: state.home.activeProcesses,
      author: state.author,
    };
    const currentHash = createHash('sha256').update(JSON.stringify({ userId, ...payload })).digest('hex');
    if (String(input.previewHash ?? '') !== currentHash) throw Object.assign(new Error('HOME changed since the reset preview'), { code: 'home_changed', status: 409 });
    if (String(input.phrase ?? '') !== 'RESET HOME') throw Object.assign(new Error('the typed confirmation phrase does not match'), { code: 'confirmation_mismatch', status: 400 });
    const reset = await withRepoLease(db, `home:${userId}`, () => resetUserHome({ db, dataDir, userId, expectedGeneration: state.home.generation }));
    return json(reset);
  }, 'admin');
}
