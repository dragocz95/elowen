import { describe, expect, it } from 'vitest';
import { pluginSettingsFields } from '../../scripts/plugin-language-fields.mjs';

describe('plugin language fields', () => {
  it('checks instance and per-account fields through one translation namespace', () => {
    const errors: string[] = [];
    const fields = pluginSettingsFields({
      configSchema: [{ key: 'instanceName', label: 'Instance name' }],
      userConfigSchema: [{ key: 'apiKey', label: 'Personal API key' }],
    }, 'raynet', errors);

    expect(fields.map((field) => field.key)).toEqual(['instanceName', 'apiKey']);
    expect(errors).toEqual([]);
  });

  it('rejects a key shared by the instance and per-account schemas', () => {
    const errors: string[] = [];
    pluginSettingsFields({
      configSchema: [{ key: 'username', label: 'Company username' }],
      userConfigSchema: [{ key: 'username', label: 'Personal username' }],
    }, 'raynet', errors);

    expect(errors).toEqual(['plugin raynet: duplicate settings field key "username"']);
  });
});
