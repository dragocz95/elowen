import type { NotificationDestinationOption } from './api.js';

const PLATFORM_RE = /^[a-z][a-z0-9-]*$/;

/** Persist a platform-specific notification target without making the target id parseable by consumers.
 * Existing raw channel ids remain valid; only values produced here opt into single-platform routing. */
export function encodeNotificationDestination(platform: string, id: string): string {
  if (!PLATFORM_RE.test(platform) || !id) throw new TypeError('invalid notification destination');
  return `destination:${platform}:${encodeURIComponent(id)}`;
}

/** Decode the reserved routed-target envelope. Values without the `destination:` prefix are legacy raw
 * ids and return null. Once the prefix is present, every malformed/unknown target fails closed instead of
 * falling back to the legacy broadcast path. */
export function decodeNotificationDestination(
  value: string | undefined,
  knownPlatforms: ReadonlySet<string>,
): { platform: string; id: string } | null {
  if (!value?.startsWith('destination:')) return null;
  const rest = value.slice('destination:'.length);
  const at = rest.indexOf(':');
  const platform = at > 0 ? rest.slice(0, at) : '';
  if (!PLATFORM_RE.test(platform)) throw new TypeError('invalid notification destination');
  if (!knownPlatforms.has(platform)) throw new Error(`notification platform "${platform}" is unavailable`);
  try {
    const id = decodeURIComponent(rest.slice(at + 1));
    if (!id) throw new TypeError('invalid notification destination');
    return { platform, id };
  } catch (error) {
    if (error instanceof TypeError && error.message === 'invalid notification destination') throw error;
    throw new TypeError('invalid notification destination');
  }
}

/** Validate and normalize one plugin-returned row before it crosses the admin API boundary. */
export function normalizeNotificationDestination(
  platform: string,
  value: unknown,
): NotificationDestinationOption | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const label = typeof row.label === 'string' ? row.label.trim() : '';
  const kind = row.kind;
  if (!id || !label || !['channel', 'thread', 'chat', 'person'].includes(String(kind))) return null;
  const group = typeof row.group === 'string' && row.group.trim() ? row.group.trim() : undefined;
  const subtitle = typeof row.subtitle === 'string' && row.subtitle.trim() ? row.subtitle.trim() : undefined;
  return {
    value: encodeNotificationDestination(platform, id),
    id,
    platform,
    kind: kind as NotificationDestinationOption['kind'],
    label,
    ...(group ? { group } : {}),
    ...(subtitle ? { subtitle } : {}),
  };
}
