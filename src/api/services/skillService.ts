import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promptsPath } from '../../prompts/index.js';
import { logger } from '../../shared/logger.js';

const log = logger('skills');

/** The agent CLIs Orca spawns, each reading `skills/<name>/SKILL.md` under its config dir. Verified on
 *  a live box: all three share the same SKILL.md format, so one master file installs natively into all
 *  of them. `configDir` resolves that dir from the provider's own env override (so a box that relocates
 *  its config is honoured) and falls back to the conventional HOME-relative default. */
const PROVIDERS: ReadonlyArray<{ id: string; configDir: (home: string, env: NodeJS.ProcessEnv) => string }> = [
  { id: 'claude-code', configDir: (home, env) => env.CLAUDE_CONFIG_DIR || join(home, '.claude') },
  { id: 'codex', configDir: (home, env) => env.CODEX_HOME || join(home, '.codex') },
  { id: 'opencode', configDir: (home, env) => join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode') },
];

const SKILL_NAME = 'orca-workflow';
const MASTER_REL = `skills/${SKILL_NAME}/SKILL.md`;

interface SkillStatus {
  /** Provider id (claude-code | codex | opencode). */
  provider: string;
  /** The provider's config root exists under HOME — i.e. the provider is actually used on this box. */
  present: boolean;
  /** Our `orca-workflow` SKILL.md exists in the provider's skills dir. */
  installed: boolean;
  /** Version parsed from the installed file's frontmatter (null when not installed/parseable). */
  version: number | null;
  /** Installed and matching the bundled master version. */
  upToDate: boolean;
}

interface InstallResult {
  provider: string;
  /** Whether the master was (re)written for this provider. */
  installed: boolean;
  /** Provider not present on this box → nothing written. */
  skipped: boolean;
  /** Set when the write failed (best-effort; one provider's failure never aborts the rest). */
  error?: string;
}

export interface SkillService {
  /** Per-provider install/version status for the System panel. */
  status(): SkillStatus[];
  /** Install (or refresh) the bundled `orca-workflow` skill into every present provider. Idempotent;
   *  atomic per file (temp + rename); other skills are never touched. */
  installAll(): InstallResult[];
}

/** Injectable bits so tests can point at a fake HOME/env and master instead of the real filesystem. */
interface SkillServiceOptions {
  /** Spawning user's HOME — defaults to the daemon process's HOME (agents run as the same user). */
  home?: string;
  /** Process env (read for the providers' config-dir overrides) — defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Reads the bundled master SKILL.md — defaults to the file under the resolved prompts dir. */
  readMaster?: () => string;
}

/** Parse `version:` from a SKILL.md's frontmatter (`metadata.version`). Scoped to the leading `---`
 *  fenced block so a `version:` mentioned in the body can't be mistaken for the real one; returns null
 *  when the file has no frontmatter. The master file is the single source of truth for the version;
 *  both the bundled master and an installed copy are parsed the same way. */
function parseVersion(text: string): number | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return null;
  const m = /version:\s*(\d+)/.exec(fm[1]!);
  return m ? Number(m[1]) : null;
}

export function createSkillService(opts: SkillServiceOptions = {}): SkillService {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const readMaster = opts.readMaster ?? (() => readFileSync(promptsPath(MASTER_REL), 'utf-8'));
  const configDirOf = (p: (typeof PROVIDERS)[number]): string => p.configDir(home, env);
  const targetFor = (configDir: string): string => join(configDir, 'skills', SKILL_NAME, 'SKILL.md');

  function status(): SkillStatus[] {
    let masterVersion: number | null = null;
    try { masterVersion = parseVersion(readMaster()); } catch { /* master unreadable → nothing up to date */ }
    return PROVIDERS.map((p) => {
      const configDir = configDirOf(p);
      const present = existsSync(configDir);
      const target = targetFor(configDir);
      const installed = existsSync(target);
      let version: number | null = null;
      if (installed) { try { version = parseVersion(readFileSync(target, 'utf-8')); } catch { /* leave null */ } }
      return { provider: p.id, present, installed, version, upToDate: installed && version !== null && version === masterVersion };
    });
  }

  function installAll(): InstallResult[] {
    let master: string;
    try { master = readMaster(); }
    catch (e) {
      log.warn(`skill master unreadable, skipping install: ${(e as Error).message}`);
      return PROVIDERS.map(({ id }) => ({ provider: id, installed: false, skipped: false, error: 'master unreadable' }));
    }
    return PROVIDERS.map((p) => {
      const configDir = configDirOf(p);
      if (!existsSync(configDir)) return { provider: p.id, installed: false, skipped: true };
      const target = targetFor(configDir);
      try {
        mkdirSync(dirname(target), { recursive: true });
        // Atomic replace: write a sibling temp then rename over the target so a reader never sees a
        // half-written file. Temp lives in the same dir to keep the rename on one filesystem; the
        // random suffix keeps concurrent installs (even same-pid) from colliding on the temp name.
        const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
        writeFileSync(tmp, master, 'utf-8');
        renameSync(tmp, target);
        return { provider: p.id, installed: true, skipped: false };
      } catch (e) {
        log.warn(`skill install failed for ${p.id}: ${(e as Error).message}`);
        return { provider: p.id, installed: false, skipped: false, error: (e as Error).message };
      }
    });
  }

  return { status, installAll };
}
