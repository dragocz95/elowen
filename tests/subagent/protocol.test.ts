import { describe, it, expect } from 'vitest';
import { parseDaemonMessage, parseRunnerMessage } from '../../src/subagent/protocol.js';

const boot = (extra: Record<string, unknown> = {}): unknown => ({
  type: 'boot',
  buildId: 'v1:1:1',
  dbPath: '/tmp/elowen.db',
  project: { id: 1, slug: 'e2e', path: '/tmp/project' },
  ...extra,
});

describe('parseDaemonMessage — boot', () => {
  it('parses a boot frame without a snapshot, and leaves the field absent', () => {
    const msg = parseDaemonMessage(boot());
    expect(msg).toEqual({ type: 'boot', buildId: 'v1:1:1', dbPath: '/tmp/elowen.db', project: { id: 1, slug: 'e2e', path: '/tmp/project' } });
    // Absent, not `undefined`: it is what the mcp plugin branches on, and "the daemon bridges nothing"
    // (an empty array) must stay distinguishable from "the daemon said nothing" (connect at boot).
    expect(msg && 'mcp' in msg).toBe(false);
  });

  it('carries a bridged-MCP snapshot through', () => {
    const mcp = [{ serverName: 'parity', tools: [{ name: 'echo_text', description: 'Echo it' }] }];
    expect(parseDaemonMessage(boot({ mcp }))).toMatchObject({ type: 'boot', mcp });
  });

  it('keeps an EMPTY snapshot, which means "connect nothing" rather than "connect everything"', () => {
    expect(parseDaemonMessage(boot({ mcp: [] }))).toMatchObject({ type: 'boot', mcp: [] });
  });

  it('refuses the whole frame when the snapshot is malformed', () => {
    // Booting without it would look identical from outside while composing a DIFFERENT tool list, so the
    // frame is dropped rather than degraded — the host's boot timeout then reports a runner that never came
    // up, which is loud, instead of a runner that quietly serves the wrong prompt.
    expect(parseDaemonMessage(boot({ mcp: 'nope' }))).toBeUndefined();
    expect(parseDaemonMessage(boot({ mcp: [{ serverName: 'parity' }] }))).toBeUndefined();
    expect(parseDaemonMessage(boot({ mcp: [{ serverName: 'parity', tools: [{ title: 'unnamed' }] }] }))).toBeUndefined();
  });

  it('still refuses a boot frame that is broken for the old reasons', () => {
    expect(parseDaemonMessage({ ...(boot() as object), dbPath: undefined })).toBeUndefined();
    expect(parseDaemonMessage({ ...(boot() as object), project: { id: 1.5, slug: 'e2e', path: '/tmp' } })).toBeUndefined();
  });
});

describe('parseRunnerMessage — delegated progress', () => {
  it('accepts compact nested lifecycle signals and rejects malformed statuses', () => {
    expect(parseRunnerMessage({
      type: 'progress', turnId: 'turn-1',
      event: { type: 'subagent', sessionId: 'brain-ch-subagent-sub-grand', status: 'running' },
    })).toEqual({
      type: 'progress', turnId: 'turn-1',
      event: { type: 'subagent', sessionId: 'brain-ch-subagent-sub-grand', status: 'running' },
    });
    expect(parseRunnerMessage({
      type: 'progress', turnId: 'turn-1',
      event: { type: 'workflow', id: 'wf-1', toolCallId: 'call-wf', status: 'done' },
    })).toEqual({
      type: 'progress', turnId: 'turn-1',
      event: { type: 'workflow', id: 'wf-1', toolCallId: 'call-wf', status: 'done' },
    });
    expect(parseRunnerMessage({
      type: 'progress', turnId: 'turn-1',
      event: { type: 'subagent', sessionId: 'brain-ch-subagent-sub-grand', status: 'paused' },
    })).toBeUndefined();
  });
});

describe('workflow host RPC — runner → daemon and back', () => {
  it('parses a call without accepting a caller session identity', () => {
    expect(parseRunnerMessage({
      type: 'hostCall', callId: 'rpc-1', turnId: 'turn-1',
      request: {
        method: 'workflow.addNodes', workflowId: 'wf-1', nodes: [{ id: 'leaf', task: 'leaf' }],
        callerSessionId: 'brain-ch-forged',
      },
    })).toEqual({
      type: 'hostCall', callId: 'rpc-1', turnId: 'turn-1',
      request: { method: 'workflow.addNodes', workflowId: 'wf-1', nodes: [{ id: 'leaf', task: 'leaf' }] },
    });
  });

  it('refuses malformed calls and responses instead of coercing them', () => {
    expect(parseRunnerMessage({ type: 'hostCall', callId: 'rpc-1', turnId: 'turn-1', request: { method: 'workflow.addNodes', workflowId: 'wf-1', nodes: 'nope' } })).toBeUndefined();
    expect(parseRunnerMessage({ type: 'hostCall', callId: 'rpc-1', turnId: 'turn-1', request: { method: 'other', workflowId: 'wf-1', nodes: [] } })).toBeUndefined();
    expect(parseDaemonMessage({ type: 'hostResult', callId: 'rpc-1', result: { added: ['leaf'] } }))
      .toEqual({ type: 'hostResult', callId: 'rpc-1', result: { added: ['leaf'] } });
    expect(parseDaemonMessage({ type: 'hostResult', callId: 'rpc-1', result: { added: [7] } })).toBeUndefined();
    expect(parseDaemonMessage({ type: 'hostError', callId: 'rpc-1', message: 'finished' }))
      .toEqual({ type: 'hostError', callId: 'rpc-1', message: 'finished' });
  });
});

describe('runner session tap — daemon → runner and back', () => {
  it('parses tap lifecycle frames and rejects malformed paging', () => {
    expect(parseDaemonMessage({
      type: 'tap', tapId: 'tap-1', userId: 1, sessionId: 'brain-ch-subagent-sub-dlg-1',
      history: { before: 8, limit: 40 },
    })).toEqual({
      type: 'tap', tapId: 'tap-1', userId: 1, sessionId: 'brain-ch-subagent-sub-dlg-1',
      history: { before: 8, limit: 40 },
    });
    expect(parseDaemonMessage({ type: 'untap', tapId: 'tap-1' })).toEqual({ type: 'untap', tapId: 'tap-1' });
    expect(parseDaemonMessage({ type: 'tap', tapId: 'tap-1', userId: 1, sessionId: 'child', history: {} })).toBeUndefined();
    expect(parseDaemonMessage({ type: 'tap', tapId: 'tap-1', userId: 0, sessionId: 'child' })).toBeUndefined();
  });

  it('parses the atomic snapshot and full live event frames', () => {
    const snapshot = { type: 'snapshot', cursor: 7, history: [], events: [{ type: 'text', delta: 'partial' }] };
    expect(parseRunnerMessage({ type: 'tapped', tapId: 'tap-1', snapshot }))
      .toEqual({ type: 'tapped', tapId: 'tap-1', snapshot });
    expect(parseRunnerMessage({ type: 'tap-event', tapId: 'tap-1', event: { type: 'tool', name: 'Read' } }))
      .toEqual({ type: 'tap-event', tapId: 'tap-1', event: { type: 'tool', name: 'Read' } });
    expect(parseRunnerMessage({ type: 'tap-error', tapId: 'tap-1', message: 'unknown session' }))
      .toEqual({ type: 'tap-error', tapId: 'tap-1', message: 'unknown session' });
    expect(parseRunnerMessage({ type: 'tapped', tapId: 'tap-1', snapshot: { type: 'snapshot' } })).toBeUndefined();
  });
});

describe('runner activity — daemon → runner and back', () => {
  it('parses correlated activity frames and rejects unsafe counts', () => {
    expect(parseDaemonMessage({ type: 'activity', activityId: 'a-1' }))
      .toEqual({ type: 'activity', activityId: 'a-1' });
    expect(parseRunnerMessage({ type: 'activity', activityId: 'a-1', activeCount: 2 }))
      .toEqual({ type: 'activity', activityId: 'a-1', activeCount: 2 });
    expect(parseDaemonMessage({ type: 'activity' })).toBeUndefined();
    expect(parseRunnerMessage({ type: 'activity', activityId: 'a-1', activeCount: -1 })).toBeUndefined();
    expect(parseRunnerMessage({ type: 'activity', activityId: 'a-1', activeCount: 1.5 })).toBeUndefined();
  });
});

describe('account process teardown — daemon → runner and back', () => {
  it('parses correlated account process frames and rejects invalid users or counts', () => {
    expect(parseDaemonMessage({ type: 'killAccountProcesses', requestId: 'k-1', userId: 7 }))
      .toEqual({ type: 'killAccountProcesses', requestId: 'k-1', userId: 7 });
    expect(parseRunnerMessage({ type: 'accountProcessesKilled', requestId: 'k-1', killed: 2 }))
      .toEqual({ type: 'accountProcessesKilled', requestId: 'k-1', killed: 2 });
    expect(parseDaemonMessage({ type: 'killAccountProcesses', requestId: 'k-1', userId: 0 })).toBeUndefined();
    expect(parseRunnerMessage({ type: 'accountProcessesKilled', requestId: 'k-1', killed: -1 })).toBeUndefined();
  });
});

describe('steer verb — daemon → runner and back', () => {
  it('parses a steer frame', () => {
    expect(parseDaemonMessage({ type: 'steer', steerId: 's-1', channelId: 'subagent-sub-dlg-1', text: 'also check docs' }))
      .toEqual({ type: 'steer', steerId: 's-1', channelId: 'subagent-sub-dlg-1', text: 'also check docs' });
  });

  it('refuses a steer frame missing its id, channel or text', () => {
    expect(parseDaemonMessage({ type: 'steer', channelId: 'c', text: 't' })).toBeUndefined();
    expect(parseDaemonMessage({ type: 'steer', steerId: 's', text: 't' })).toBeUndefined();
    expect(parseDaemonMessage({ type: 'steer', steerId: 's', channelId: 'c' })).toBeUndefined();
    // An empty text would queue a blank user message and still be reported 'delivered' — refused whole.
    expect(parseDaemonMessage({ type: 'steer', steerId: 's', channelId: 'c', text: '' })).toBeUndefined();
  });

  it('parses every steered verdict and nothing else', () => {
    for (const outcome of ['delivered', 'idle', 'aborted'] as const) {
      expect(parseRunnerMessage({ type: 'steered', steerId: 's-1', outcome }))
        .toEqual({ type: 'steered', steerId: 's-1', outcome });
    }
    // The daemon ACTS on this verdict (falls back and re-delivers, or reports the delegation aborted), so
    // an unknown outcome must drop the frame rather than be coerced into a wrong obligation.
    expect(parseRunnerMessage({ type: 'steered', steerId: 's-1', outcome: 'maybe' })).toBeUndefined();
    expect(parseRunnerMessage({ type: 'steered', outcome: 'delivered' })).toBeUndefined();
  });
});
