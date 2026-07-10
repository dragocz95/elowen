import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Surface } from '../../../components/ui/Surface';
import { EntityList, EntityRow } from '../../../components/ui/EntityList';
import { DataTable, DataTableCell, DataTableRow } from '../../../components/ui/DataTable';
import { AdaptiveSplit, PageFrame } from '../../../components/ui/PageFrame';
import { MotionLayout, MotionLayoutItem } from '../../../components/ui/Motion';
import { createWrapper } from '../../test-utils';

describe('interaction patterns', () => {
  it('expresses surface state independently from elevation', () => {
    render(<Surface as="section" level="raised" selected busy={false}>Project</Surface>);
    expect(screen.getByText('Project')).toHaveAttribute('data-state', 'selected');
    expect(screen.getByText('Project')).toHaveClass('bg-elevated', 'border-accent');
  });

  it('provides one semantic entity-register contract', () => {
    render(<EntityList aria-label="Projects"><EntityRow selected>Elowen</EntityRow></EntityList>);
    expect(screen.getByRole('list', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveAttribute('data-state', 'selected');
  });

  it('provides responsive table and page composition contracts', () => {
    render(
      <PageFrame toolbar={<button>Filter</button>}>
        <AdaptiveSplit aside={<div>Detail</div>}>
          <DataTable ariaLabel="Usage" columns="1fr 8rem">
            <DataTableRow header><DataTableCell header>Model</DataTableCell><DataTableCell header priority="wide">Tokens</DataTableCell></DataTableRow>
          </DataTable>
        </AdaptiveSplit>
      </PageFrame>,
    );
    expect(screen.getByRole('table', { name: 'Usage' })).toHaveStyle({ '--data-table-columns': '1fr 8rem' });
    expect(screen.getByRole('columnheader', { name: 'Tokens' })).toHaveAttribute('data-priority', 'wide');
    expect(screen.getByText('Detail')).toBeInTheDocument();
  });

  it('keeps layout-animated content mounted', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><MotionLayout><MotionLayoutItem layoutId="alpha">Alpha</MotionLayoutItem></MotionLayout></Wrapper>);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});
