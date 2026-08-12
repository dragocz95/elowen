import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CliStatus {
  name: string;
  installed: boolean;
  functional: boolean;
  version: string | null;
  error: string | null;
}

export interface FreshInstallInfo {
  /** True when no settings have been persisted (DB row missing or all-default). */
  noConfigPersisted: boolean;
  /** True when no API key for the autopilot has been set. */
  noApiKey: boolean;
  /** True when no custom providers or models have been configured. */
  noCustomSetup: boolean;
}

export interface CliDetectionResult {
  tools: CliStatus[];
  summary: {
    allInstalled: boolean;
    allFunctional: boolean;
  };
  freshInstall: FreshInstallInfo;
}

// `optional` tools are extra agent CLIs ELOWEN can drive but doesn't require — they're detected and
// displayed, yet excluded from the allInstalled/allFunctional summary so a box without them isn't
// flagged "missing tools". (omp runs on the Bun runtime, so it needs `bun` on the daemon's PATH.)
const TOOLS = [
  { name: 'claude', bin: 'claude', versionArg: '--version' },
  { name: 'codex', bin: 'codex', versionArg: '--version' },
  { name: 'opencode', bin: 'opencode', versionArg: '--version' },
  { name: 'kilo', bin: 'kilo', versionArg: '--version', optional: true },
  { name: 'pi', bin: 'pi', versionArg: '--version', optional: true },
  { name: 'omp', bin: 'omp', versionArg: '--version', optional: true },
  { name: 'node', bin: 'node', versionArg: '--version' },
  { name: 'tmux', bin: 'tmux', versionArg: '-V' },
  { name: 'git', bin: 'git', versionArg: '--version' },
];

async function checkTool(name: string, bin: string, versionArg: string): Promise<CliStatus> {
  const result: CliStatus = { name, installed: false, functional: false, version: null, error: null };

  try {
    await execFileAsync('which', [bin], { timeout: 5000 });
    result.installed = true;
  } catch {
    result.error = `'${bin}' not found on PATH`;
    return result;
  }

  try {
    const { stdout } = await execFileAsync(bin, [versionArg], { encoding: 'utf8', timeout: 8000 });
    result.functional = true;
    result.version = stdout.trim().split('\n')[0] ?? null;
  } catch (e) {
    result.error = (e as Error).message;
  }

  return result;
}

export interface DetectionContext {
  /** Whether the settings row exists in the DB at all. */
  configPersisted: boolean;
  /** Whether an API key has been set. */
  hasApiKey: boolean;
  /** Whether custom providers have been configured (non-default bin paths, extra models, etc.). */
  hasCustomSetup: boolean;
}

export async function detectClis(context?: DetectionContext): Promise<CliDetectionResult> {
  // Probe every tool concurrently: a serial sweep would sum each binary's start-up cost (kilo 7.x
  // boots a daemon/DB on `--version`, ~2.4s), so concurrency keeps the endpoint at the slowest
  // single probe rather than the sum of all nine.
  const tools = await Promise.all(TOOLS.map((t) => checkTool(t.name, t.bin, t.versionArg)));
  const freshInstall = context
    ? {
        noConfigPersisted: !context.configPersisted,
        noApiKey: !context.hasApiKey,
        noCustomSetup: !context.hasCustomSetup,
      }
    : { noConfigPersisted: false, noApiKey: false, noCustomSetup: false };
  // The summary reflects only required tools; optional agent CLIs are detected/displayed but never
  // drag allInstalled/allFunctional to false on a box that simply doesn't use them.
  const required = tools.filter((_, i) => !TOOLS[i]?.optional);
  return {
    tools,
    summary: {
      allInstalled: required.every((t) => t.installed),
      allFunctional: required.every((t) => t.functional),
    },
    freshInstall,
  };
}
