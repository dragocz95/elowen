const PREFIX = 'plugin-account:';

export function pluginAccountSectionId(plugin: string, section: string): `plugin-account:${string}` {
  return `${PREFIX}${encodeURIComponent(plugin)}:${encodeURIComponent(section)}`;
}

export function parsePluginAccountSectionId(value: string): { plugin: string; section: string } | null {
  if (!value.startsWith(PREFIX)) return null;
  const split = value.indexOf(':', PREFIX.length);
  if (split < 0) return null;
  try {
    const plugin = decodeURIComponent(value.slice(PREFIX.length, split));
    const section = decodeURIComponent(value.slice(split + 1));
    return plugin && section ? { plugin, section } : null;
  } catch {
    return null;
  }
}
