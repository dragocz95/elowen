import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../../../lib/i18n';
import type { Memory } from '../../../lib/types';
import { MemoryBrainMap } from '../../../modules/memory/MemoryBrainMap';

const memory = {
  id: 1, user_id: 1, body: 'A memory node', kind: 'fact', importance: 3,
  confidence: 0.9, source: 'user', status: 'active', category_id: null,
  created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
  last_used_at: null, use_count: 0,
} as Memory;

describe('MemoryBrainMap touch targets', () => {
  it('keeps the leaf glyph small while giving its action a 32px hit area', () => {
    render(<LanguageProvider><MemoryBrainMap memories={[memory]} categories={[]} /></LanguageProvider>);
    const node = screen.getByTestId('memory-leaf-node');
    expect(node).toHaveClass('h-8', 'w-8');
    expect(node.querySelector('.h-2.w-2')).not.toBeNull();
    expect(node.querySelector('.brain-node-label')).toHaveClass('top-7');
  });
});
