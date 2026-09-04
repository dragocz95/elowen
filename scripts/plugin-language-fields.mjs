/**
 * Return every manifest field localized through the shared `i18n.fields` namespace.
 * Instance and per-account schemas must stay together: separating them makes personal
 * credentials silently fall back to English and turns valid translations into orphans.
 */
export function pluginSettingsFields(manifest, pluginName, errors = []) {
  const fields = [
    ...(Array.isArray(manifest.configSchema) ? manifest.configSchema : []),
    ...(Array.isArray(manifest.userConfigSchema) ? manifest.userConfigSchema : []),
  ];
  const seen = new Set();
  for (const field of fields) {
    if (seen.has(field.key)) errors.push(`plugin ${pluginName}: duplicate settings field key "${field.key}"`);
    seen.add(field.key);
  }
  return fields;
}
