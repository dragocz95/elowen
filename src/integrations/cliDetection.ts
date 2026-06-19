import { execFileSync } from 'node:child_process';

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

const TOOLS = [
  { name: 'claude', bin: 'claude', versionArg: '--version' },
  { name: 'codex', bin: 'codex', versionArg: '--version' },
  { name: 'opencode', bin: 'opencode', versionArg: '--version' },
  { name: 'node', bin: 'node', versionArg: '--version' },
  { name: 'tmux', bin: 'tmux', versionArg: '-V' },
  { name: 'git', bin: 'git', versionArg: '--version' },
];

function checkTool(name: string, bin: string, versionArg: string): CliStatus {
  const result: CliStatus = { name, installed: false, functional: false, version: null, error: null };

  try {
    execFileSync('which', [bin], { stdio: 'pipe', timeout: 5000 });
    result.installed = true;
  } catch {
    result.error = `'${bin}' not found on PATH`;
    return result;
  }

  try {
    const stdout = execFileSync(bin, [versionArg], { stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
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
  /** Total number of users in the system. */
  userCount: number;
  /** Total number of projects. */
  projectCount: number;
}

export function detectClis(context?: DetectionContext): CliDetectionResult {
  const tools = TOOLS.map((t) => checkTool(t.name, t.bin, t.versionArg));
  const freshInstall = context
    ? {
        noConfigPersisted: !context.configPersisted,
        noApiKey: !context.hasApiKey,
        noCustomSetup: !context.hasCustomSetup,
      }
    : { noConfigPersisted: false, noApiKey: false, noCustomSetup: false };
  return {
    tools,
    summary: {
      allInstalled: tools.every((t) => t.installed),
      allFunctional: tools.every((t) => t.functional),
    },
    freshInstall,
  };
}
