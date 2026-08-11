import { randomBytes } from 'node:crypto';

// Real, friendly agent names. The overseer ("Pilot") assigns these to spawned agents.
const NAMES = [
  'Nova', 'Atlas', 'Iris', 'Felix', 'Juno', 'Orion', 'Luna', 'Cyrus',
  'Vera', 'Milo', 'Nora', 'Hugo', 'Ada', 'Leo', 'Mira', 'Theo',
  'Ivy', 'Kai', 'Zara', 'Otis', 'Lena', 'Cleo', 'Remy', 'Soren',
];
let counter = 0;

export function uniqueName(): string {
  const n = counter++;
  const name = NAMES[n % NAMES.length]!;
  const cycle = Math.floor(n / NAMES.length);
  return cycle === 0 ? name : `${name}${cycle + 1}`; // Nova, …, Soren, Nova2, …
}

/** Pick a friendly agent name whose tmux session (`elowen-[prefix]<name>`) is NOT already live, so a
 *  fresh agent can never collide with a lingering session — which `tmux new-session` rejects as a
 *  duplicate (the counter resets to 0 on daemon restart, so early names would otherwise reappear and
 *  clash with anything still running). Re-rolls `make()` past live names; if every candidate is taken
 *  it appends a short random suffix, keeping the friendly base for the UI. */
export async function freeAgentName(make: () => string, liveSessions: () => Promise<string[]>, prefix = ''): Promise<string> {
  const live = new Set(await liveSessions());
  const isFree = (name: string) => !live.has(`elowen-${prefix}${name}`);
  let last = make();
  for (let i = 0; i < NAMES.length * 2; i++) {
    if (isFree(last)) return last;
    last = make();
  }
  // Pathologically saturated (or a degenerate `make`): guarantee uniqueness with a random suffix.
  for (let i = 0; i < 1000; i++) {
    const candidate = `${last}-${randomBytes(3).toString('hex')}`;
    if (isFree(candidate)) return candidate;
  }
  return `${last}-${randomBytes(8).toString('hex')}`; // astronomically certain to be free
}
