// Read-only view of the non-send control calls the UI posted upstream (the /model switch, the Stop abort),
// via the fake daemon's `GET /__test/calls`. Lets a spec assert the EXACT payload the web sent — e.g. that
// clicking Stop posted `/brain/abort` for the bound session, or that the picker posted the chosen model.
// The recorded shape is imported type-only from the daemon handler so a reshaped record breaks here, never
// a stale copy.
import type { APIRequestContext } from '@playwright/test';
import type { RecordedCall } from '../fake-daemon/handlers/brain.ts';
import { DAEMON_URL } from './env.ts';

type ModelCall = Extract<RecordedCall, { kind: 'model' }>;
type AbortCall = Extract<RecordedCall, { kind: 'abort' }>;

export class Calls {
  constructor(private readonly request: APIRequestContext) {}

  /** Every recorded control call, in the order the UI posted them. */
  async all(): Promise<RecordedCall[]> {
    const res = await this.request.get(`${DAEMON_URL}/__test/calls`);
    const body = (await res.json()) as { calls: RecordedCall[] };
    return body.calls;
  }

  /** The `POST /brain/model` calls (the model-picker switches). */
  async models(): Promise<ModelCall[]> {
    return (await this.all()).filter((c): c is ModelCall => c.kind === 'model');
  }

  /** The `POST /brain/abort` calls (the Stop button). */
  async aborts(): Promise<AbortCall[]> {
    return (await this.all()).filter((c): c is AbortCall => c.kind === 'abort');
  }
}
