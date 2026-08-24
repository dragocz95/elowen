import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PLATFORM_IDENTITIES, PLATFORM_SURFACES, PLATFORM_LINK_KEYS, platformIdentity } from '../../src/shared/platformIdentity.js';
import { ACTIVITY_SURFACES } from '../../src/api/sse.js';
import { SLASH_COMMANDS } from '../../src/brain/slashCommands.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const DESCRIPTOR_MODULE = join(SRC, 'shared', 'platformIdentity.ts');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Every quoted occurrence of `needle` — the shape a re-listed platform literal actually takes. */
function quotedLiterals(source: string, needle: string): RegExpMatchArray[] {
  return [...source.matchAll(new RegExp(`['"\`]${needle}['"\`]`, 'g'))];
}

/** Prose naming a platform is fine; CODE re-listing one is what drifts. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The ONLY places in `src/` allowed to spell a platform out, each pinned to the exact snippet that may
 *  do so and to the reason it is not a re-listed identity model. Pinning the snippet rather than the file
 *  keeps the exemption honest: any OTHER platform literal in the same file still offends, and an
 *  exemption whose snippet has disappeared fails rather than quietly covering nothing. */
const PLATFORM_LITERAL_EXEMPTIONS: readonly { file: string; snippet: string; reason: string }[] = [
  {
    file: 'shared/wireContract.ts',
    snippet: "export type PlatformSurface = 'discord' | 'msteams' | 'telegram' | 'whatsapp';",
    reason: 'declares the union itself — wireContract may import nothing, and the test below pins it to the descriptors',
  },
  {
    file: 'store/db.ts',
    snippet: "for (const name of ['discord', 'whatsapp']) if (configs?.[name])",
    reason: 'the plugins carrying a `visionModel` config — a DIFFERENT set that happens to share two names, mirrored in configStore',
  },
  {
    file: 'store/configStore.ts',
    snippet: "[['discord', 'visionModel'], ['whatsapp', 'visionModel']",
    reason: 'the same visionModel plugin-config set as the db migration above',
  },
  {
    file: 'auth/msSso.ts',
    snippet: "const PROVIDER = 'msteams';",
    reason: 'this module IS the Microsoft provider adapter; the literal is its OAuth provider id, and the link KEY it writes comes from the descriptor',
  },
];

describe('platform identity is data, not literals', () => {
  // The whole point of the descriptor set: nothing but the descriptors gets to enumerate platforms or
  // identity keys. The file set is EVERY source file, not the ones that import the module — a consumer
  // that re-lists the platforms is most dangerous precisely when it never imported them (that is how
  // Telegram ended up supported in three files and absent from a fourth). Legitimate exceptions are
  // named above with their reason; there is no way to opt out by omission.
  it('nothing outside the descriptor module re-lists a platform or a link key', () => {
    const files = tsFiles(SRC).filter((path) => path !== DESCRIPTOR_MODULE);
    expect(files.length).toBeGreaterThanOrEqual(50);
    const offenders = files.flatMap((path) => {
      const rel = path.slice(SRC.length + 1);
      let code = withoutComments(readFileSync(path, 'utf8'));
      for (const exemption of PLATFORM_LITERAL_EXEMPTIONS.filter((e) => e.file === rel)) {
        expect(code, `stale exemption: ${rel} no longer contains ${exemption.snippet}`).toContain(exemption.snippet);
        code = code.split(exemption.snippet).join('');
      }
      return [...PLATFORM_SURFACES, ...PLATFORM_LINK_KEYS]
        .flatMap((needle) => quotedLiterals(code, needle).map(() => `${rel}: '${needle}'`));
    });
    expect(offenders).toEqual([]);
    // …and the descriptors really are consumed rather than merely un-contradicted.
    const consumers = tsFiles(SRC).filter((path) => readFileSync(path, 'utf8').includes('shared/platformIdentity.js'));
    expect(consumers.length).toBeGreaterThanOrEqual(6);
  });

  // `resolvePlatformUser` decides WHO a sender is; a platform literal in it is the exact shape of the
  // defect this phase removes (Telegram supported in three files and absent from a fourth).
  it('resolvePlatformUser contains no platform literal at all', () => {
    const source = readFileSync(join(SRC, 'daemon', 'brainCore.ts'), 'utf8');
    const start = source.indexOf('const resolvePlatformUser =');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n  };', start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    // It must actually go through the descriptor lookup, not merely avoid the words.
    expect(body).toContain('platformIdentity(platform)');
    for (const needle of [...PLATFORM_SURFACES, ...PLATFORM_LINK_KEYS]) {
      expect(quotedLiterals(body, needle), `resolvePlatformUser mentions '${needle}'`).toEqual([]);
    }
  });

  // The surface unions must be GENERATED from the descriptor set. Spreading is what makes the next
  // platform reach the activity feed and every slash-command surface without a second edit.
  it('the surface unions spread the descriptor set instead of re-listing it', () => {
    const sse = readFileSync(join(SRC, 'api', 'sse.ts'), 'utf8');
    expect(sse).toMatch(/ACTIVITY_SURFACES = \[[^\]]*\.\.\.PLATFORM_SURFACES/);
    const wire = readFileSync(join(SRC, 'shared', 'wireContract.ts'), 'utf8');
    expect(wire).toMatch(/type SlashSurface = [^;]*PlatformSurface/);
    // `wireContract.ts` must import nothing (tests/contract/wireContractIsolation.test.ts), so the
    // platform union is DECLARED there and the descriptors are typed against it. That makes a platform
    // with no union member a compile error — but a union member with no descriptor would be a platform
    // nobody can link, which is the original defect. Pin the two together by reading the union back.
    const union = wire.match(/export type PlatformSurface = ([^;]+);/)?.[1];
    expect(union, 'wireContract no longer declares PlatformSurface').toBeTruthy();
    const declared = [...(union ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...declared].sort()).toEqual([...PLATFORM_SURFACES].sort());
    // …and the generated values really do carry every platform.
    for (const platform of PLATFORM_SURFACES) {
      expect(ACTIVITY_SURFACES as readonly string[]).toContain(platform);
    }
    // A platform-facing slash command reaches every platform, never a subset somebody typed out.
    const status = SLASH_COMMANDS.find((c) => c.name === 'status');
    expect(status?.surfaces).toEqual([...PLATFORM_SURFACES]);
  });

  // The partial UNIQUE indexes are the backstop against two accounts claiming one identity. They are
  // created per descriptor, under the names live databases already carry, so no data migration is owed.
  it('creates one partial unique index per descriptor, under its pinned name', () => {
    const db = readFileSync(join(SRC, 'store', 'db.ts'), 'utf8');
    expect(db).toMatch(/for \(const d of PLATFORM_IDENTITIES\)/);
    const schema = readFileSync(join(SRC, 'store', 'schema.sql'), 'utf8');
    for (const d of PLATFORM_IDENTITIES) {
      // The declarative baseline a fresh database is built from must agree with the descriptors, or a
      // new install would silently be the one instance where squatting is possible.
      expect(schema, `schema.sql is missing ${d.indexName}`).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${d.indexName} ON user_settings(value) WHERE key = '${d.linkSettingKey}'`);
    }
  });

  // Bootstrap is an authentication-grade claim: a platform may bind a sender with NO pre-existing link.
  // Only Microsoft Teams earns it, because only the Bot Framework hands the daemon an e-mail it has
  // itself validated. Everything else must be linked explicitly by the account holder.
  it('only a platform that authenticates its sender carries a bootstrap', () => {
    expect(PLATFORM_IDENTITIES.filter((d) => d.bootstrap).map((d) => d.platform)).toEqual(['msteams']);
    expect(platformIdentity('msteams')?.bootstrap).toEqual({ verifiedEmailUnique: true, externalProvider: 'msteams' });
  });

  // `as const` is compile-time only, and `indexName` / `linkSettingKey` go straight into DDL — whatever
  // could assign to a descriptor at runtime would be writing SQL. Nothing can reach them today; the
  // freeze is what keeps that true without anyone having to re-derive the reachability argument.
  it('freezes the descriptor set at runtime, not merely in the type system', () => {
    expect(Object.isFrozen(PLATFORM_IDENTITIES)).toBe(true);
    for (const d of PLATFORM_IDENTITIES) {
      expect(Object.isFrozen(d), `${d.platform} descriptor is mutable`).toBe(true);
      if (d.bootstrap) expect(Object.isFrozen(d.bootstrap), `${d.platform} bootstrap is mutable`).toBe(true);
    }
  });

  // Normalisation runs on BOTH the value a user types and the id an adapter reports, so it has to be
  // idempotent — otherwise a link stored from the account view would not match the same person's turns.
  it('every descriptor normalises idempotently and refuses an empty identity', () => {
    const samples = ['', '   ', '123456789012345678', ' 123 456 789 ', '420778433908@s.whatsapp.net', 'AAAA-bbbb', '29:abcdefghijklmnop'];
    for (const d of PLATFORM_IDENTITIES) {
      for (const sample of samples) {
        const once = d.normalize(sample);
        expect(d.normalize(once), `${d.platform} normalize is not idempotent for '${sample}'`).toBe(once);
      }
      expect(d.validate(''), `${d.platform} accepts an empty identity`).toBe(false);
    }
  });
});
