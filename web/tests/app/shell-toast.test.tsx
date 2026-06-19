import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { render } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ replace: () => {}, push: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { Shell } from '../../components/shell/Shell';
import { useToast } from '../../components/ui/Toast';

class FakeES { onmessage = null; addEventListener() {} close() {} constructor(public url: string) {} }
(globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;
const server = setupServer(http.get('http://localhost:4400/health', () => HttpResponse.json({ ok: true })));
beforeAll(() => server.listen({ onUnhandledRequest })); afterAll(() => { localStorage.clear(); server.close(); });

function Probe() { useToast(); return <span>ok</span>; }

describe('Shell provides ToastProvider', () => {
  it('useToast works inside Shell without throwing', () => {
    localStorage.setItem('orca.token', 'test-token'); // authed → LoginGate renders children
    expect(() => render(<Shell><Probe /></Shell>)).not.toThrow();
  });
});
