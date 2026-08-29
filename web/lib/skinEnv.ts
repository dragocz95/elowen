// Server-side only. Split from lib/skins.ts because that module is now imported by client components
// too (the switcher needs the registry), and a client bundle must not carry a read of a server-only
// environment variable — it would silently resolve to "unset" in the browser and quietly disagree with
// what the server rendered.
import { SKINS, type SkinName } from './skins';

/** Same single-segment grammar the theme system uses — the value lands in a DOM attribute. */
const SKIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const warned = new Set<string>();

/** The instance's preferred skin from the ELOWEN_SKIN env var (systemd deployment config — a deliberate
 *  operator decision). It is what anyone sees who has not chosen a skin of their own, and what a revoked
 *  choice tries first. Null means the caller must use DEFAULT_SKIN (studio-light); malformed and unknown
 *  names warn once so a typo in a unit file is diagnosable from the web log. */
export function activeSkin(): SkinName | null {
  const raw = (process.env.ELOWEN_SKIN ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (SKIN_NAME_RE.test(raw) && (SKINS as readonly string[]).includes(raw)) return raw as SkinName;
  if (!warned.has(raw)) {
    warned.add(raw);
    console.warn(`skins: ELOWEN_SKIN="${raw}" does not match any compiled skin (${SKINS.join(', ')}) — using studio-light`);
  }
  return null;
}
