// Server-side only (read from the root layout). Skins are CODE, not data: each one is a stylesheet in
// web/skins/<name>/skin.css, compiled into the build and scoped under `:root[data-skin='<name>']`, so
// one build carries every design and an instance picks its own. This is deliberately the opposite
// trade-off from the runtime theme system (lib/brandServer.ts): a skin may restyle ANYTHING — layout,
// panels, navigation — because it ships and is tested together with the markup it targets, while a
// theme is validated data limited to brand tokens precisely because it lives outside the repo.

/** Every skin compiled into this build. A new skin needs: a folder web/skins/<name>/ with skin.css,
 *  an @import line in web/skins/index.css, and its name here — a contract test holds the three in sync. */
export const SKINS = ['midnight'] as const;
export type SkinName = (typeof SKINS)[number];

/** Same single-segment grammar the theme system uses — the value lands in a DOM attribute. */
const SKIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const warned = new Set<string>();

/** The instance's active skin from the ELOWEN_SKIN env var (systemd/docker deployment config — a
 *  deliberate operator decision, not an admin-UI setting). Null for unset, malformed or unknown values:
 *  the app then renders the built-in ember design with markup byte-identical to a skinless build.
 *  An unknown name warns once so a typo in a unit file is diagnosable from the web log. */
export function activeSkin(): SkinName | null {
  const raw = (process.env.ELOWEN_SKIN ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (SKIN_NAME_RE.test(raw) && (SKINS as readonly string[]).includes(raw)) return raw as SkinName;
  if (!warned.has(raw)) {
    warned.add(raw);
    console.warn(`skins: ELOWEN_SKIN="${raw}" does not match any compiled skin (${SKINS.join(', ')}) — using the built-in design`);
  }
  return null;
}
