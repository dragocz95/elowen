import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EngageForm } from '../../../components/control/EngageForm';

describe('EngageForm defaults', () => {
  it('initializes autonomy and maxSessions from props', () => {
    render(<EngageForm onEngage={() => {}} defaultAutonomy="L1" defaultMaxSessions={4} />);
    expect((screen.getByDisplayValue('L1') as HTMLSelectElement).value).toBe('L1');
    expect((screen.getByDisplayValue('4') as HTMLInputElement).value).toBe('4');
  });
});
