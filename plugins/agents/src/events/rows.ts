import type { EventPersistenceRow } from '../../../../src/plugins/api.js';
import type { ElowenEvent } from '../../../../src/api/sse.js';

/** Activity-log persistence for the subsystem's own events — the row shapes the core EventStore used
 *  to build before the extraction. The `type` strings MUST stay exactly these: old persisted rows are
 *  read back by the same names, so the timeline stays one continuous format across the move. Pure so
 *  the store tests and the registration share one mapping. */
export function agentsEventRow(e: ElowenEvent): EventPersistenceRow | undefined {
  switch (e.type) {
    case 'mission':
      // The label snapshot names the epic task inside a mission id (m-<epicId>).
      return { type: 'mission', target: e.missionId, detail: e.state, labelTitleId: e.missionId.startsWith('m-') ? e.missionId.slice(2) : null };
    case 'review':
      return { type: 'review', target: e.taskId, detail: `${e.approve ? 'approved' : 'escalated'}: ${e.rationale}`, labelTitleId: e.taskId };
    // An autopilot decision on an agent prompt/question — the human-readable payload is JSON so the
    // task detail can render question + verdict + rationale + confidence (read back via try/catch).
    case 'decision':
      return { type: 'decision', target: e.taskId, detail: JSON.stringify({ kind: e.kind, question: e.question, outcome: e.outcome, rationale: e.rationale, confidence: e.confidence, optionLabel: e.optionLabel }), labelTitleId: e.taskId };
    // A worker↔autopilot conversation turn — role + text as JSON so the task detail renders chat bubbles.
    case 'message':
      return { type: 'message', target: e.taskId, detail: JSON.stringify({ role: e.role, text: e.text }), labelTitleId: e.taskId };
    case 'signal':
      return { type: 'signal', target: e.session, detail: e.signal.type };
    default:
      return undefined; // not this subsystem's event
  }
}
