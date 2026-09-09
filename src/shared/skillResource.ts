import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';

export const DIRECTORY_SKILL_FILE = 'SKILL.md';

/** The directory a skill may serve support files from, or `null` when it has none.
 *
 *  Only the Agent-Skills DIRECTORY form has one. Its skill file is `<dir>/SKILL.md` and the folder around
 *  it belongs to that skill alone, which is exactly what "read reference.md next to this file" means.
 *
 *  A FLAT skill is a single `<name>.md` sitting in a shared loader folder, and the loader pins that whole
 *  folder as its base — for the instance skills directory that folder also holds `users/<id>/*.md`, every
 *  account's personal skills. Treating the pinned base as a resource root therefore let ONE visible flat
 *  skill authorize reading every other skill file on the instance, including another account's private
 *  ones. Reproduced against the real layout before this guard existed. A flat skill has no support root at
 *  all: its only file is the one SkillLoad already returned, so nothing is lost by refusing.
 *
 *  The skill file is resolved and required to be exactly `<canonicalBase>/SKILL.md`, which also ties the
 *  pinned base to the skill it was pinned for: a base that no longer holds this skill's own file stops
 *  qualifying instead of quietly widening. Nested deeper, differently named, or unreadable — all `null`. */
export function directorySkillResourceRoot(canonicalBase: string | null | undefined, skillFilePath: string | null | undefined): string | null {
  if (typeof canonicalBase !== 'string' || typeof skillFilePath !== 'string') return null;
  const base = canonicalBase.trim();
  const file = skillFilePath.trim();
  if (!base || !isAbsolute(base) || base.includes('\0')) return null;
  if (!file || !isAbsolute(file) || file.includes('\0')) return null;
  const prefix = base.endsWith(sep) ? base : base + sep;
  try {
    return realpathSync(file) === prefix + DIRECTORY_SKILL_FILE ? base : null;
  } catch {
    return null;
  }
}

/** Contain one support-file path inside a skill's base directory, as that directory was PINNED.
 *
 *  This is the single containment rule behind `SkillResourcesControl.resolveResource`, kept apart from the
 *  registry so the boundary can be tested against real directories and symlinks rather than through a
 *  plugin load.
 *
 *  `canonicalBase` is the immutable string the registry canonicalized at REGISTRATION time and it is
 *  compared as a string, never resolved again. Re-realpathing it was an escape, not a refinement:
 *  replacing the pinned directory with a symlink to somewhere else made the base follow the attacker, and
 *  every file under the new target then satisfied the prefix check. Pinning is the whole point of pinning,
 *  so a base that has since been moved or replaced simply stops matching and the read is refused.
 *
 *  Only the TARGET is resolved, and only an ABSOLUTE request is accepted — the exact path SkillLoad
 *  disclosed. Relative input is refused outright rather than resolved against the base, because a relative
 *  name collides with whatever the caller's own working directory means and gives an attacker a second
 *  string to aim at the same check. Empty input and NUL bytes never reach the filesystem, the target must
 *  land strictly inside the base rather than on it, and only a regular file resolves: a directory, a
 *  socket or a device is not a skill resource. Every refusal returns `null` without saying which rule
 *  refused it, because "that file does not exist" and "you may not read there" are the same answer to a
 *  caller that should not learn the difference. */
export function containedSkillResource(canonicalBase: string, requestedPath: string): string | null {
  if (typeof canonicalBase !== 'string' || typeof requestedPath !== 'string') return null;
  const base = canonicalBase.trim();
  const requested = requestedPath.trim();
  if (!base || !isAbsolute(base) || base.includes('\0')) return null;
  if (!requested || !isAbsolute(requested) || requested.includes('\0')) return null;
  const prefix = base.endsWith(sep) ? base : base + sep;
  try {
    const target = realpathSync(requested);
    if (!target.startsWith(prefix)) return null;
    return statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}
