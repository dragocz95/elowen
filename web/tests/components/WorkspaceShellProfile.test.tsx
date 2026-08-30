import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Bot, Server } from 'lucide-react';
import { WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { WorkspaceMetric } from '../../components/ui/WorkspaceHero';

/** The shell used to ship TWO page anatomies and choose between them by shell profile: the command
 *  layout, and a spatial one that opened on a mascot hero and a circular section rail. A page could
 *  therefore not be read without also knowing which design was on the document, and the profile-specific
 *  half was the one no shipped design selects — so it was never seen and never asserted either.
 *
 *  Every compiled skin in this build is a `command` profile, so the only way to prove the branch is GONE
 *  rather than merely unreachable is to force the other value. The mock is hoisted, which is what makes
 *  it reach the module under test: were the branch back, `useShellProfile()` would answer `spatial` here
 *  and the rail would appear instead of the segmented navigation. The `lib/shellProfile` module itself
 *  left with its last consumer (the old dashboard hero), so today the mock stands guard over a path
 *  that does not resolve — exactly the state a returning branch would have to change first.
 *
 *  The command-profile anatomy is asserted in WorkspaceShell.test.tsx, against the real hook. The two
 *  lists are deliberately written out in both files rather than shared: an anatomy that changed in one
 *  place and was edited in one place is exactly the regression this pair exists to catch. */
vi.mock('../../lib/shellProfile', () => ({ useShellProfile: () => 'spatial' }));

const sections = [
  { id: 'system', label: 'System', icon: Server },
  { id: 'brain', label: 'Models', icon: Bot },
];

describe('the page anatomy does not depend on the shell profile', () => {
  it('renders the command anatomy even when the profile says spatial', () => {
    const { container } = render(
      <WorkspaceShell
        variant="register"
        hero={{ title: 'Memory', mascot: 'idle', metrics: <WorkspaceMetric label="Active" value={4} /> }}
        navigation={{ sections, value: 'system', onChange: vi.fn(), ariaLabel: 'Sections' }}
      >
        <div>Register</div>
      </WorkspaceShell>,
    );

    const shell = container.querySelector('.workspace-shell');
    expect([...(shell?.children ?? [])].map((child) => child.className.split(' ')[0])).toEqual([
      'workspace-hero',
      'workspace-shell__section-navigation',
      'page-toolbar',
      'workspace-shell__content',
    ]);
    expect(container.querySelector('.workspace-hero__mascot')).toBeNull();
    expect(screen.queryByTestId('spatial-section-rail')).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Sections' })).toBeInTheDocument();
  });
});
