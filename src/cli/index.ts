import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OrcaClient } from './client.js';

const BASE = process.env.ORCA_URL ?? 'http://localhost:4400';

async function ensureDaemon() {
  if (process.env.ORCA_AUTOSTART === '0') return;
  try { await fetch(`${BASE}/health`); return; } catch { /* down — start daemon */ }
  const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.js');
  spawn(process.execPath, [entry], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); return; } catch { /* not healthy yet — retry */ await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('orca daemon did not become healthy');
}

/** Read `--flag value` from an argv slice; returns undefined when the flag is absent. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean { return args.includes(name); }

export async function run(argv: string[], c: OrcaClient, env: NodeJS.ProcessEnv): Promise<void> {
  const [cmd, arg, ...rest] = argv;
  switch (cmd) {
    case 'ls': console.log(JSON.stringify(await c.tasks(), null, 2)); break;
    case 'ready': console.log(JSON.stringify(await c.ready(), null, 2)); break;
    case 'sessions': console.log(JSON.stringify(await c.sessions(), null, 2)); break;
    case 'close': {
      if (!arg) { console.error('usage: orca close <taskId> [--summary "<text>"] [--outcome ok|fail]'); process.exit(1); }
      const outcome = flag(rest, '--outcome');
      // Reject a typo'd outcome instead of silently storing null — the agent would otherwise think it
      // closed "ok"/"fail" while the task records no outcome at all.
      if (outcome !== undefined && outcome !== 'ok' && outcome !== 'fail') { console.error('orca close: --outcome must be ok or fail'); process.exit(2); }
      await c.close(arg, { summary: flag(rest, '--summary'), outcome });
      console.log(`closed ${arg}`); break;
    }
    case 'plan': {
      if (arg !== 'submit') { console.error("usage: orca plan submit --phases '<json>'"); process.exit(1); }
      const jobId = env.ORCA_PLAN_JOB;
      if (!jobId) { console.error('orca plan submit: ORCA_PLAN_JOB is not set'); process.exit(1); }
      const raw = flag(rest, '--phases') ?? '[]';
      let phases: unknown;
      try { phases = JSON.parse(raw); } catch { console.error('orca plan submit: --phases is not valid JSON'); process.exit(1); }
      await c.planSubmit(jobId, phases);
      console.log(`submitted plan to ${jobId}`); break;
    }
    case 'overseer': {
      const missionId = env.ORCA_MISSION;
      if (!missionId) { console.error('orca overseer: ORCA_MISSION is not set'); process.exit(1); }
      if (arg === 'poll') {
        // Absorb heartbeats HERE, in the CLI process, so the (LLM-driven) overseer agent is woken
        // only for a real decision. The server long-poll returns `{}` every ~25s to keep the HTTP
        // request from hanging; surfacing those heartbeats to the model would force a fresh round-trip
        // (and token spend) every 25s for an otherwise-idle overseer. Loop until a decision (`id`) or
        // an error arrives; when the mission ends the daemon kills this session, ending the loop.
        for (;;) {
          const r = await c.overseerPoll(missionId) as Record<string, unknown> | null;
          if (r && (r.id || r.error)) { console.log(JSON.stringify(r, null, 2)); break; }
          // heartbeat (`{}`) — the server already blocked ~25s, so just poll again.
        }
        break;
      }
      if (arg === 'decide') {
        const id = flag(rest, '--id');
        if (!id) { console.error('usage: orca overseer decide --id <id> (--approve|--escalate) [--confidence <0..1>] [--rationale "<text>"]'); process.exit(1); }
        const approve = has(rest, '--approve');
        const confidence = approve ? Number(flag(rest, '--confidence') ?? '0.7') : 0;
        await c.overseerDecide(missionId, { id, approve, confidence: Number.isFinite(confidence) ? confidence : 0, rationale: flag(rest, '--rationale') ?? '' });
        console.log(`decided ${id}`); break;
      }
      console.error('usage: orca overseer <poll|decide ...>'); process.exit(1); break;
    }
    default: console.error('usage: orca <ls|ready|sessions|close|plan submit|overseer poll|overseer decide>'); process.exit(1);
  }
}

async function main() {
  await ensureDaemon();
  const c = new OrcaClient(BASE, process.env.ORCA_TOKEN);
  await run(process.argv.slice(2), c, process.env);
}

// Run only when invoked as the binary, not when imported (e.g. by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
