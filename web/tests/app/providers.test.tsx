import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Providers } from '../../app/providers';

class FakeES { addEventListener() {} close() {} constructor(public url: string) {} }
beforeEach(() => { (globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES; });

describe('Providers', () => {
  it('renders children inside the query provider', () => {
    render(<Providers><span>child</span></Providers>);
    expect(screen.getByText('child')).toBeInTheDocument();
  });
});
