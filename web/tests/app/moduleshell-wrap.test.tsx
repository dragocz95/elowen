import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/settings', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
import { render } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import SettingsPage from '../../app/settings/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: [] })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterAll(() => server.close());

describe('settings page module wrapper', () => {
  it('renders inside [data-module="settings"]', () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    expect(container.querySelector('[data-module="settings"]')).not.toBeNull();
  });
});
