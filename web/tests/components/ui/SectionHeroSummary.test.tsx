import { render, screen } from '@testing-library/react';
import { Cpu } from 'lucide-react';
import { SectionHeroSummary } from '../../../components/ui/SectionHeroSummary';

describe('SectionHeroSummary', () => {
  it('provides the shared Account and Settings section identity grammar', () => {
    const { container } = render(<SectionHeroSummary icon={Cpu} title="Models" description="Available workers" />);
    expect(screen.getByText('Models')).toHaveClass('section-hero-summary__label');
    expect(screen.getByText('Available workers')).toBeInTheDocument();
    expect(container.querySelector('.section-hero-summary__icon')).toBeInTheDocument();
  });
});
