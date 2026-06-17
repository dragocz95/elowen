import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { render } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
import { Shell } from '../../components/shell/Shell';
import { useToast } from '../../components/ui/Toast';

class FakeES { onmessage = null; addEventListener() {} close() {} constructor(public url: string) {} }
(globalThis as any).EventSource = FakeES as any;
const server = setupServer(http.get('http://localhost:4400/health', () => HttpResponse.json({ ok: true })));
beforeAll(() => server.listen()); afterAll(() => server.close());

function Probe() { useToast(); return <span>ok</span>; }

describe('Shell provides ToastProvider', () => {
  it('useToast works inside Shell without throwing', () => {
    expect(() => render(<Shell><Probe /></Shell>)).not.toThrow();
  });
});
