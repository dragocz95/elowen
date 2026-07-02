import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import SettingsPage from '../../app/settings/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: [], autopilot: { model: 'm', apiUrl: 'u', apiKeySet: false } })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterAll(() => server.close());

describe('settings page module wrapper', () => {
  it('renders inside [data-module="settings"]', () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    expect(container.querySelector('[data-module="settings"]')).not.toBeNull();
  });
});
