// Shared MSW unhandled-request policy.
//
// The app shell and several shared hooks poll a handful of GET endpoints in the background
// (sidebar session/task counts, config, auth, the project list). Those polls fire whenever a
// component is mounted, even in tests that aren't about that data — drowning the output in
// "[MSW] unhandled request" warnings. We silence ONLY those ambient GETs; every other unhandled
// request still warns, so a genuinely missing handler is never masked. A test that actually
// asserts on this data stubs it explicitly (its handler matches first), so silencing the fallback
// changes nothing it relies on.
const AMBIENT = ['/config', '/sessions', '/tasks', '/missions', '/projects', '/auth/me', '/setup'];

export function onUnhandledRequest(request: Request, print: { warning: () => void; error: () => void }): void {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && AMBIENT.some((p) => pathname === p || pathname.startsWith(p + '/'))) return;
  print.warning();
}
