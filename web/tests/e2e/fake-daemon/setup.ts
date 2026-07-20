// Fresh-install (onboarding) lane state for the fake daemon. The real daemon reports `needsSetup` purely
// from `users.count() === 0` and leaves the create-user route open until the first admin exists; after
// that, auth re-engages. This models exactly that count==0 → first-admin transition behind a control
// toggle (`POST /__test/setup { needsSetup }`), so the onboarding spec can drive the whole gate.
//
// While setup mode is ON and no user has been created, `GET /setup` returns needsSetup:true (the login
// gate routes to /onboarding) and `POST /users` is open (creates the bootstrap admin). Creating the first
// user flips needsSetup:false — the same moment the real daemon's auth boundary re-engages.

interface FakeUser {
  readonly id: number;
  readonly username: string;
}

let setupMode = false;
const users: FakeUser[] = [];

/** Turn the fresh-install lane on/off (the control channel's `POST /__test/setup`). Toggling always
 *  clears any user created in a previous lane so the state is deterministic per test. */
export function setSetupMode(on: boolean): void {
  setupMode = on;
  users.length = 0;
}

/** The daemon's fresh-install signal: setup mode is armed AND no admin exists yet (users.count()===0). */
export function needsSetup(): boolean {
  return setupMode && users.length === 0;
}

/** Create the next user (the onboarding bootstrap-admin path). Returns the created row. */
export function addUser(username: string): FakeUser {
  const user: FakeUser = { id: users.length + 1, username };
  users.push(user);
  return user;
}

/** The users the daemon knows about (empty until onboarding creates the first admin). */
export function listUsers(): readonly FakeUser[] {
  return users;
}

/** Clear the setup lane (the control channel's `POST /__test/reset`). */
export function resetSetup(): void {
  setupMode = false;
  users.length = 0;
}
