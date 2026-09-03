import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, expectTypeOf } from 'vitest';
import ts from 'typescript';
import type {
  User as WireUser,
  MemoryRow as WireMemoryRow,
  MemoryCategoryRow as WireMemoryCategoryRow,
  MemoryEventRow as WireMemoryEventRow,
  BrainLimits as WireBrainLimits,
  BrainUsage as WireBrainUsage,
  BrainGoalState as WireBrainGoalState,
  CommitFileChange as WireCommitFileChange,
  CommitLogEntry as WireCommitLogEntry,
  ProjectView as WireProjectView,
} from '../../../src/shared/wireContract.js';
import type {
  User as WebUser,
  Memory as WebMemory,
  MemoryCategory as WebMemoryCategory,
  MemoryEvent as WebMemoryEvent,
  BrainLimits as WebBrainLimits,
  BrainUsage as WebBrainUsage,
  BrainGoal as WebBrainGoal,
  CommitFileChange as WebCommitFileChange,
  CommitLogEntry as WebCommitLogEntry,
  Project as WebProject,
} from '../../lib/types';

/** The web cannot import daemon types (src/ is off-limits to the web toolchain by design), so the
 *  hand-mirrored DTOs in web/lib/types.ts are guarded by comparing them against the daemon's OWN
 *  interface declarations, read as plain source data (not imported). This is what turned the real
 *  /auth/me incident — the daemon grew `advisor_exec`/`advisor_autostart` and the web mirror lagged —
 *  into a test failure instead of a silent `undefined` at runtime.
 *
 *  The pairs whose web copies were exact have since moved ONCE into src/shared/wireContract.ts and are
 *  re-exported by both toolchains, so this file guards only the shapes whose web variants deliberately
 *  diverge; the shared ones are pinned by the type-identity checks in the second describe below. */
interface Member {
  type: string;
  optional: boolean;
}

/** One mirrored pair: the web DTO in web/lib/types.ts and the daemon interface it copies. Every daemon
 *  field must be mirrored unless it is named in `allowMissing`. A blanket "the web may omit anything"
 *  mode would stay silent on precisely the drift this test exists to catch — the daemon growing a field
 *  the web never picks up, which is what the /auth/me incident was. Naming each omission keeps the
 *  decision explicit and forces a fresh one when the daemon shape changes. */
interface MirrorPair {
  web: string;
  daemonFile: string;
  daemon: string;
  allowMissing?: readonly string[];
}

/** The web suite runs with cwd = web/, but never assume it: walk up until the repo root (the dir that
 *  holds both src/ and web/) is found, so the daemon sources resolve regardless of how vitest started. */
function repoRoot(): string {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'src')) && existsSync(join(dir, 'web/lib/types.ts'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('repo root (dir with src/ and web/) not found above ' + process.cwd());
}

const WEB_TYPES_FILE = join(repoRoot(), 'web/lib/types.ts');
const DAEMON_ROOT = join(repoRoot(), 'src/');

const PAIRS: MirrorPair[] = [
  // showThoughtsCli is optional on the web but always sent by the daemon — a tolerated relaxation the
  // mirror keeps honest (the web's test literals construct the settings without it).
  { web: 'TerminalSettings', daemonFile: `${DAEMON_ROOT}store/terminalSettings.ts`, daemon: 'TerminalSettings' },
  // NOTE: the work bundle's own `Task` mirror (plugins/work/web-src/types.ts) used to be pinned here.
  // The work plugin moved to the plugin registry, so that file is not in this repo and the pin cannot
  // live here any more. It is NOT covered by anything else: the registry's schema-parity suites pin SQL
  // DDL, not the wire shape, and its UI tests only import the type. The registry depends on `elowen`,
  // so the replacement pin belongs there, reading this daemon interface out of `elowen/dist`.
];

const normalize = (type: string): string => type.replace(/\s+/g, ' ').trim();

/** Expand type-alias references (e.g. `TaskOutcome`, `TaskStatus`) to their literal bodies so a
 *  change inside the alias — not just at the member site — also trips the mirror. */
function resolveAliases(type: string, aliases: Map<string, string>): string {
  const expanding = new Set<string>();
  const resolve = (text: string): string => {
    let out = text;
    for (const [name, body] of aliases) {
      if (expanding.has(name)) continue; // TS bans direct alias cycles; this is just a guard
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      if (re.test(out)) {
        expanding.add(name);
        out = out.replace(re, resolve(body));
        expanding.delete(name);
      }
    }
    return out;
  };
  return resolve(type);
}

function load(file: string): { sourceFile: ts.SourceFile; aliases: Map<string, string> } {
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
      aliases.set(stmt.name.text, stmt.type.getText(sourceFile));
    }
  }
  return { sourceFile, aliases };
}

function interfaceMembers(parsed: ReturnType<typeof load>, name: string): Map<string, Member> {
  const decl = parsed.sourceFile.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name,
  );
  if (!decl) throw new Error(`${name} interface not found in ${parsed.sourceFile.fileName}`);
  const members = new Map<string, Member>();
  for (const member of decl.members) {
    if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name)) continue;
    const typeText = member.type ? member.type.getText(parsed.sourceFile) : '';
    members.set(member.name.text, {
      type: normalize(resolveAliases(typeText, parsed.aliases)),
      optional: Boolean(member.questionToken),
    });
  }
  return members;
}

/** The web may narrow a daemon `string` to the closed set of values the daemon is documented to
 *  produce (Memory.status, Task.outcome); every other mismatch is drift. */
function typesCompatible(daemon: string, web: string): boolean {
  if (daemon === web) return true;
  const webIsLiteralUnion = web.split(' | ').every((p) => p === 'null' || (p.startsWith("'") && p.endsWith("'")));
  if ((daemon === 'string' || daemon === 'string | null') && webIsLiteralUnion) {
    return daemon.includes('null') === web.includes('null');
  }
  return false;
}

/** The web may treat a daemon-required field as optional (it tolerates absence), but never the
 *  reverse: a web-required field the daemon may omit is `undefined` waiting to happen. */
function optionalityCompatible(daemon: Member, web: Member): boolean {
  return web.optional || !daemon.optional;
}

function comparePair(pair: MirrorPair): string[] {
  const daemonParsed = load(pair.daemonFile);
  const webParsed = load(WEB_TYPES_FILE);
  const daemonMembers = interfaceMembers(daemonParsed, pair.daemon);
  const webMembers = interfaceMembers(webParsed, pair.web);

  const errors: string[] = [];
  for (const [name, daemonMember] of daemonMembers) {
    const webMember = webMembers.get(name);
    if (!webMember) {
      if (!pair.allowMissing?.includes(name)) {
        errors.push(`daemon ${pair.daemon}.${name} missing on web ${pair.web} — mirror it, or add it to allowMissing if the web deliberately does not render it`);
      }
      continue;
    }
    if (!typesCompatible(daemonMember.type, webMember.type)) {
      errors.push(`web ${pair.web}.${name}: ${webMember.type} does not accept daemon ${pair.daemon}.${name}: ${daemonMember.type}`);
    }
    if (!optionalityCompatible(daemonMember, webMember)) {
      errors.push(`web ${pair.web}.${name} is required but daemon ${pair.daemon}.${name} is optional`);
    }
  }
  for (const name of webMembers.keys()) {
    if (!daemonMembers.has(name)) {
      errors.push(`web ${pair.web}.${name} does not exist on daemon ${pair.daemon}`);
    }
  }
  return errors;
}

describe('web DTO mirrors of daemon shapes', () => {
  it.each(PAIRS.map((p) => [p.web, p] as const))('%s mirrors the daemon shape', (_label, pair) => {
    const errors = comparePair(pair);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

/** The moved pairs are SHARED, not mirrored: the web re-exports the daemon's type instead of declaring
 *  its own copy, so drift is impossible by construction. The only way it can return is someone replacing
 *  a re-export with a local redeclaration — so pin the identity at TYPECHECK time (web/tsconfig.json
 *  includes this file): `toEqualTypeOf` fails to compile the moment the web's exported name resolves to
 *  a local copy that diverged from the wire shape. The runtime assertion itself passes trivially —
 *  type identity cannot be observed from a value — which is exactly why the gate that matters here is
 *  `cd web && npx tsc --noEmit`, not the vitest run. */
describe('web types ARE the shared wire contract', () => {
  it('re-exports the shared shapes, not local copies', () => {
    expectTypeOf<WebUser>().toEqualTypeOf<WireUser>();
    // Memory deliberately extends the shared row: the daemon's routes attach the server-computed
    // `vitality` (the DTO's `MemoryWithVitality`), so the web shape is the raw row plus exactly that field.
    expectTypeOf<WebMemory>().toEqualTypeOf<WireMemoryRow & { vitality: number }>();
    expectTypeOf<WebMemoryCategory>().toEqualTypeOf<WireMemoryCategoryRow>();
    expectTypeOf<WebMemoryEvent>().toEqualTypeOf<WireMemoryEventRow>();
    expectTypeOf<WebBrainLimits>().toEqualTypeOf<WireBrainLimits>();
    expectTypeOf<WebBrainUsage>().toEqualTypeOf<WireBrainUsage>();
    expectTypeOf<WebBrainGoal>().toEqualTypeOf<WireBrainGoalState>();
    expectTypeOf<WebCommitFileChange>().toEqualTypeOf<WireCommitFileChange>();
    expectTypeOf<WebCommitLogEntry>().toEqualTypeOf<WireCommitLogEntry>();
    expectTypeOf<WebProject>().toEqualTypeOf<WireProjectView>();
  });
});
