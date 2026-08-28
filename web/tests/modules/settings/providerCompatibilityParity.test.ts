import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const daemon = read('../../../../src/store/configStore.ts');
const web = read('../../../modules/settings/ProviderCompatibilityModal.tsx');

function objectBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n};', start);
  expect(end, `${marker} is not closed`).toBeGreaterThan(start);
  return source.slice(start + marker.length, end);
}

function fields(source: string, marker: string): Record<string, boolean | string> {
  const block = objectBlock(source, marker);
  const out: Record<string, boolean | string> = {};
  for (const [, key, raw] of block.matchAll(/(\w+):\s*(true|false|'[^']+'),/g)) {
    out[key] = raw === 'true' ? true : raw === 'false' ? false : raw.slice(1, -1);
  }
  return out;
}

describe('provider compatibility defaults', () => {
  it('keeps the new-provider modal on the daemon conservative baseline', () => {
    const daemonDefaults = fields(daemon, 'export const DEFAULT_OPENAI_COMPATIBILITY: BrainProviderCompatibility = {');
    const webDefaults = fields(web, 'export const DEFAULT_PROVIDER_COMPATIBILITY: BrainProviderCompatibility = {');
    expect(webDefaults).toEqual(daemonDefaults);
    expect(daemonDefaults).toEqual({
      supportsDeveloperRole: false,
      supportsLongCacheRetention: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
      supportsStore: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_completion_tokens',
    });
  });
});
