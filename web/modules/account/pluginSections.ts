const PREFIX = 'plugin-account:';
const USER_CONFIG_PREFIX = 'plugin-user-config:';

export function pluginUserConfigSectionId(plugin: string): `plugin-user-config:${string}` {
  return `${USER_CONFIG_PREFIX}${encodeURIComponent(plugin)}`;
}

export function parsePluginUserConfigSectionId(value: string): { plugin: string } | null {
  if (!value.startsWith(USER_CONFIG_PREFIX)) return null;
  try {
    const plugin = decodeURIComponent(value.slice(USER_CONFIG_PREFIX.length));
    return plugin ? { plugin } : null;
  } catch {
    return null;
  }
}

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
