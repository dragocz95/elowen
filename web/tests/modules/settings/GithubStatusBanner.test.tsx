import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import type { GithubAuthStatus } from '../../../lib/types';

const useGithubStatus = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries', () => ({ useGithubStatus }));

import { GithubStatusBanner } from '../../../modules/settings/GithubStatusBanner';

const renderBanner = () => render(<LanguageProvider><GithubStatusBanner /></LanguageProvider>);
const status = (s: Partial<GithubAuthStatus>): GithubAuthStatus =>
  ({ ghInstalled: false, ghAuthenticated: false, account: null, tokenSet: false, ready: false, method: 'none', ...s });

describe('GithubStatusBanner', () => {
  beforeEach(() => useGithubStatus.mockReset());

  it('renders nothing while the probe is loading', () => {
    useGithubStatus.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the gh account when ready via the gh CLI', () => {
    useGithubStatus.mockReturnValue({ data: status({ ghInstalled: true, ghAuthenticated: true, account: 'dragocz1995', ready: true, method: 'gh' }), isLoading: false });
    renderBanner();
    expect(screen.getByText(/@dragocz1995/)).toBeInTheDocument();
    expect(screen.queryByText(/gh auth login/)).not.toBeInTheDocument();
  });

  it('shows the token posture when ready via a stored token', () => {
    useGithubStatus.mockReturnValue({ data: status({ tokenSet: true, ready: true, method: 'token' }), isLoading: false });
    renderBanner();
    expect(screen.getByText(/access token/i)).toBeInTheDocument();
  });

  it('warns with the actionable hint when no GitHub auth is available', () => {
    useGithubStatus.mockReturnValue({ data: status({ ready: false, method: 'none' }), isLoading: false });
    renderBanner();
    expect(screen.getByText(/can’t push|nemůžou pushnout/i)).toBeInTheDocument();
    expect(screen.getByText(/gh auth login/)).toBeInTheDocument();
  });
});
