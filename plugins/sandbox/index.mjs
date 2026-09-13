import { initSandboxDb, reconcileStaleLeases } from './lib/db.mjs';
import {
  bubblewrapProbe, createExecutionService, listUserRoots, migrateLegacyHomes, removeUserData,
} from './lib/execution.mjs';
import { registerSandboxApi } from './lib/api.mjs';
import { createEnvironmentRuntime } from './lib/environmentRuntime.mjs';
import { registerEnvironmentApi } from './lib/environmentApi.mjs';
import { registerEnvironmentTools } from './lib/environmentTools.mjs';

export async function register(ctx) {
  const db = initSandboxDb(ctx);
  const dataDir = ctx.dataDir();
  // Forked sub-agent runners consume the daemon-migrated database and must not race a filesystem handoff.
  // They still create account HOME lazily through prepareExecution when a delegated command actually runs.
  const migrationState = typeof process.send === 'function'
    ? { collisions: [], migrated: 0, retainedSessions: [] }
    : migrateLegacyHomes(dataDir);
  const environments = createEnvironmentRuntime({ ctx, db, dataDir });
  const execution = createExecutionService({ ctx, db, dataDir, managedRuntime: environments });

  ctx.registerControl('sandbox', {
    ...environments.control,
    // For a caller with NO ambient turn to read — a background service has neither an identity nor a set
    // of allowed roots, so it must name the account and the directories itself and owns the tenancy rule
    // for what it named. What it may NOT name is `owner`: that flag selects DIRECT execution (no
    // bubblewrap, and the daemon's whole environment handed to the child). It is a property of who is
    // driving the turn, never of what a plugin asks for, so an explicit request is always confined.
    // `skipHomeLock` stays internal too: the lease has to be minted under the HOME lock or a reset can
    // race a launch.
    //
    // A managed project is not routed here: `execution.prepare` below already answers a managed
    // reference by handing it to the same environment runtime with the same account.
    prepareExecution: (input, options) => execution.prepare(
      input,
      options === undefined ? undefined : {
        accountUserId: options.accountUserId,
        roots: options.roots,
        owner: false,
        forceConfined: true,
      },
    ),
  });

  registerSandboxApi({ ctx, db, dataDir, execution, migrationState });
  registerEnvironmentApi(ctx, environments);
  registerEnvironmentTools(ctx, environments.control);

  ctx.registerReadinessCheck(() => {
    if (migrationState.collisions.length > 0) return {
      id: 'sandbox', label: 'Environments', ok: false,
      detail: 'Legacy and current account HOME directories both exist; migration was refused.',
      hint: 'Inspect plugins-data/terminal/sandbox-home and plugins-data/sandbox/users before choosing which HOME to retain.',
    };
    if (migrationState.retainedSessions.length > 0) return {
      id: 'sandbox', label: 'Environments', ok: false,
      detail: `${migrationState.retainedSessions.length} legacy session HOME director${migrationState.retainedSessions.length === 1 ? 'y is' : 'ies are'} retained because process ownership cannot be verified.`,
      hint: 'Confirm no legacy process uses these directories, then remove them manually from plugins-data/terminal/sandbox-home.',
    };
    if (ctx.config.confineNonOperators === false) return {
      id: 'sandbox', label: 'Environments', ok: true,
      detail: 'Account HOME is ready; non-operator confinement is disabled by configuration.',
    };
    const probe = bubblewrapProbe();
    return probe.available
      ? { id: 'sandbox', label: 'Environments', ok: true, detail: 'bubblewrap confinement probe passed; account HOME is ready.' }
      : { id: 'sandbox', label: 'Environments', ok: false, detail: `Confined execution is unavailable: ${probe.reason || 'probe failed'}.`, hint: 'Install bubblewrap and permit its unprivileged namespace profile; non-operator shell commands fail closed until the probe passes.' };
  });

  ctx.registerBootReconcile(async () => {
    reconcileStaleLeases(db);
    // Account HOME belongs to an account, so a directory whose account no longer exists is left over from
    // a deletion that did not finish — either the crash it interrupted or an instance predating
    // `registerUserRemoved`. The durable account list is the authority, not the directory.
    const knownUsers = new Set(ctx.host.stores().usersRead.list().map((user) => user.id));
    for (const userId of listUserRoots(dataDir)) {
      if (!knownUsers.has(userId)) await removeUserData(dataDir, userId, { warn: (message) => ctx.logger.warn(message) });
    }
    await environments.reconcile();
  });

  ctx.registerInterval('lease-reconcile', async () => { reconcileStaleLeases(db); await environments.reconcile(); }, 10_000);

  ctx.registerUserRemoved(async (userId) => {
    await environments.revokeAccount(userId);
    await removeUserData(dataDir, userId, { warn: (message) => ctx.logger.warn(message) });
  });

  ctx.registerHook({
    name: 'plugin.reload.before',
    run: async () => {
      await environments.dispose();
      // The durable rows intentionally survive a reload. Only stale owners are reaped; live children keep
      // their leases until their real exit so HOME deletion remains blocked across generations.
      reconcileStaleLeases(db);
    },
  });

  ctx.logger.info(`registered account HOME, execution control and managed project environments${migrationState.migrated ? `; migrated ${migrationState.migrated} legacy HOME(s)` : ''}`);
}
