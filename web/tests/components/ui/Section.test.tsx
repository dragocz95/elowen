import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Section } from '../../../components/ui/Section';

describe('Section', () => {
  it('renders the title + actions + body', () => {
    render(<Section title="Overview" actions={<button>act</button>}><p>body</p></Section>);
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'act' })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });
});
