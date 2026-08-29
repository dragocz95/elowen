import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { BrainModelField } from '../../../components/ui/BrainModelField';
import { ChoiceField } from '../../../components/ui/ChoiceField';
import { ModelCatalogField } from '../../../components/ui/ModelCatalogField';
import type { BrainModelOption } from '../../../lib/types';

const BRAIN = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus', exec: 'elowen:anthropic/claude-opus', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
] as unknown as BrainModelOption[];

const mount = (node: React.ReactNode) => render(<LanguageProvider>{node}</LanguageProvider>);

/** The shared field wrappers are what a settings or account record actually puts in its trailing cell.
 *  They all rendered a `SelectionSummary` — a bordered card with a count line, sample chips and a
 *  "Manage" button beside them. That is a section summary: it is two or three lines tall, it draws its
 *  own frame inside a card that already has one, and every one of them on a page offered a screen reader
 *  the same word. A record's control is one line, one control, named for its field. */
describe('shared field wrappers are row controls, not summary cards', () => {
  const cases: { name: string; label: string; render: () => React.ReactNode }[] = [
    {
      name: 'ChoiceField (picker branch)',
      label: 'Effects',
      render: () => (
        <ChoiceField title="Effects" value="auto" onChange={() => {}} options={[
          { value: 'auto', label: 'Auto' }, { value: 'full', label: 'Full' },
          { value: 'reduced', label: 'Reduced' }, { value: 'off', label: 'Off' },
        ]} />
      ),
    },
    {
      name: 'ModelCatalogField',
      label: 'Embedding model',
      render: () => <ModelCatalogField value="text-embedding-3" onChange={() => {}} catalog={['text-embedding-3']} title="Embedding model" />,
    },
    {
      name: 'BrainModelField',
      label: 'Vision model',
      render: () => <BrainModelField value="" onChange={() => {}} models={BRAIN} title="Vision model" defaultLabel="Default" keyOf={(m) => m.exec} />,
    },
  ];

  for (const item of cases) {
    it(`${item.name} renders one trigger named for its field and no summary card`, () => {
      const { container } = mount(item.render());

      expect(container.querySelector('[data-selection-summary]')).toBeNull();
      expect(container.querySelector('[data-selection-manage]')).toBeNull();
      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveAccessibleName(item.label);
      expect(buttons[0]).toHaveAttribute('aria-haspopup', 'dialog');
    });
  }

  /** Three choices or fewer stay inline as a Segmented — a radiogroup, not a dialog trigger. That
   *  branch is the one presentation here that was never a summary card, and it must stay. */
  it('ChoiceField keeps the inline Segmented for a short list', () => {
    const { container } = mount(
      <ChoiceField title="Mode" value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />,
    );

    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument();
    expect(container.querySelector('[data-selection-summary]')).toBeNull();
  });

  /** `variant="line"` was the summary card's quiet document treatment. The prop survives the migration
   *  with the same meaning rather than becoming a silently ignored argument: it drops the trigger's
   *  border instead of the card's chrome. */
  it('ModelCatalogField still honours its quiet `line` variant', () => {
    mount(<ModelCatalogField value="" onChange={() => {}} catalog={[]} title="Embedding model" variant="line" />);
    const quiet = screen.getByRole('button', { name: 'Embedding model' });

    mount(<ModelCatalogField value="" onChange={() => {}} catalog={[]} title="Categorization model" />);
    const bordered = screen.getByRole('button', { name: 'Categorization model' });

    expect(quiet.className).toContain('border-transparent');
    expect(bordered.className).toContain('border-border');
  });
});
