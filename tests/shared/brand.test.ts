import { describe, it, expect } from 'vitest';
import { resolveBrand, DEFAULT_BRAND, DEFAULT_AGENT_NAME } from '../../src/shared/brand.js';

const cfg = (agentName: string, active: string | null) => ({ brain: { agentName }, theme: { active } });

describe('resolveBrand', () => {
  it('with no theme and the default config returns the built-in brand', () => {
    expect(resolveBrand(cfg('Elowen', null), null)).toEqual(DEFAULT_BRAND);
  });

  it('an explicit configured agentName wins over the theme brand', () => {
    const brand = resolveBrand(cfg('Jarvis', 'acme'), { agentName: 'Acme Bot', productName: 'Acme' });
    expect(brand.agentName).toBe('Jarvis');
    expect(brand.productName).toBe('Acme'); // renaming the persona never relabels the product
  });

  // The stored default counts as "not set": a fresh install that persisted 'Elowen' as a VALUE must not
  // block the theme from naming the persona — that asymmetry is the whole point of the resolver.
  it('the stored default agentName does not block the theme', () => {
    const brand = resolveBrand(cfg(DEFAULT_AGENT_NAME, 'acme'), { agentName: 'Acme Bot' });
    expect(brand.agentName).toBe('Acme Bot');
  });

  it('a one-name theme brands both agent and product', () => {
    const brand = resolveBrand(cfg('Elowen', 'acme'), { agentName: 'Acme Bot' });
    expect(brand).toEqual({ agentName: 'Acme Bot', productName: 'Acme Bot', themeName: 'acme' });
  });

  it('productName never comes from brain.agentName', () => {
    const brand = resolveBrand(cfg('Jarvis', null), null);
    expect(brand.agentName).toBe('Jarvis');
    expect(brand.productName).toBe(DEFAULT_AGENT_NAME);
  });
});
