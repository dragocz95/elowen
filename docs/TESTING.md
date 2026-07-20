# Testing

Elowen has separate daemon and web test suites. Run them from their own
dependency roots so Vitest resolves the intended configuration and test setup.

## Daemon

Daemon tests live in `tests/` and cover API routes, CLI behavior, daemon
wiring, brain/inference flows, missions, stores, plugins, terminal transport,
and tmux abstractions.

```bash
npm test
npm run test:watch
```

Use focused Vitest paths while iterating, then run the relevant full suite
before handoff. `npm run test:cli-tmux` additionally builds the project and
checks the built CLI/tmux path; it needs tmux available on the machine.

Tests should exercise behavior through real interfaces with controlled fakes:

- use fake clocks for time-sensitive behavior;
- use fake tmux, inference, and transport dependencies instead of live remote
  systems;
- create isolated temporary data for store/integration cases rather than
  relying on a developer's runtime state;
- add regression coverage at the route, service, or CLI boundary where the bug
  occurred.

`tests/contract/` holds cross-stack conformance tests: when a daemon engine is
deliberately mirrored in the web bundle (for example the transcript fold), the
contract test runs the same battery through both implementations and asserts
identical output, so the copy cannot silently drift.

## Web

Web tests live in `web/tests/` and use Vitest, React Testing Library,
`@testing-library/user-event`, and MSW.

```bash
npm --prefix web test
npm --prefix web run test:watch
```

The app uses React Query, so test loading, error, optimistic-update, and
invalidation behavior rather than just static rendering. Mock daemon calls with
the shared MSW setup; do not make real daemon or browser-network calls from
unit tests.

For UI changes, cover the interaction that matters: keyboard navigation and
focus for overlays, selection/search for shared pickers, auto-save state for
settings, and Czech/English text where applicable.

### Browser E2E (Playwright)

Browser-level E2E tests live in `web/tests/e2e/`, in a `*.e2e.ts` glob that is
excluded from the Vitest tree, Knip, dependency-cruiser, and ESLint. The app
under test is the real Next.js server running against a fake Hono daemon that
serves canned REST responses and a scriptable SSE stream through an out-of-band
control channel — so the genuine cookie/BFF/EventSource/transcript pipeline is
exercised while only the nondeterministic agent brain is replaced. The fake
daemon imports the daemon's wire event types type-only, so a renamed event
breaks the E2E typecheck.

Page objects (`ShellPage`, `ChatPage`) and fixtures centralize every selector;
add UI hooks as non-behavioral `data-testid` attributes rather than styling
selectors.

```bash
npm --prefix web run e2e        # full suite
npm --prefix web run e2e:smoke  # fast @smoke subset
```

CI does not run the browser suite — run it locally after chat-surface, proxy,
or onboarding changes.

## Static and production checks

Run the smallest relevant set while developing, then use the full checks for a
cross-cutting change:

```bash
npm run lint
npm run typecheck
npm run deadcode
npm run depcruise
npm run build
npm run build:web
```

`npm run check` combines the four static checks. `npm run build` also verifies
the daemon's deterministic `dist/` artifact; `npm run build:web` verifies the
standalone `web-dist/` package artifact.

## CI

The GitHub Actions workflow for `main` runs three independent jobs:

| Job | Verification |
| --- | --- |
| Lint | ESLint, Knip, and dependency-cruiser with both dependency trees installed |
| Daemon | Build, daemon Vitest suite, and built CLI/tmux check |
| Web | Next.js production build and the web Vitest suite |

CI uses Node 22. A local change that touches both daemon and web code should
normally run `npm run check`, `npm test`, `npm run build`, `npm --prefix web
test`, and `npm run build:web` before review.
