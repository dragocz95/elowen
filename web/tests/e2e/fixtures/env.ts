// Where the fake daemon listens — mirrors the `FAKE_DAEMON_PORT` logic in playwright.config.ts (kept in
// lockstep). The control channel (`/__test/*`) is NOT a product route, so it is not reachable through the
// web's `/api/*` BFF proxy; the fixtures POST to it directly at this absolute base.
const FAKE_DAEMON_PORT = Number(process.env.FAKE_DAEMON_PORT ?? 4599);
export const DAEMON_URL = `http://127.0.0.1:${FAKE_DAEMON_PORT}`;
