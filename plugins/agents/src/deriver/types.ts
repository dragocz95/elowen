// Part of the core event contract (rides the `signal` SSE event) — defined in shared/, re-exported
// here so the deriver's own modules keep their import path until the extraction moves them.
import type { DerivedSignal, SignalSink } from '../../../../src/shared/agentEvents.js';

export type { DerivedSignal, SignalSink };
