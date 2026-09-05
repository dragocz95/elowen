import { expect, test } from 'vitest';
import { MARKERS, startRecoveryModel } from '../../scripts/tests/recovery-e2e/model.mjs';

test('owner stop acts on input despite a historical recovery delivery tag', async () => {
  const model = await startRecoveryModel({ task: MARKERS.foregroundTask, result: MARKERS.foregroundResult, holdRecovered: true });
  try {
    const child = 'brain-ch-subagent-recovering-child';
    const messages = [
      { role: 'user', content: MARKERS.foregroundTask },
      { role: 'assistant', content: 'Calling Delegate.', tool_calls: [
        { id: 'delegate', type: 'function', function: { name: 'Delegate', arguments: JSON.stringify({ task: MARKERS.foregroundTask }) } },
      ] },
      { role: 'tool', tool_call_id: 'delegate', content: '[interrupted, resuming] The result is delivered as a <subagent-result> system message.' },
      { role: 'user', content: `${MARKERS.stopRecoveredChild} stopChild=${child}` },
    ];
    const request = async () => {
      const response = await fetch(`${model.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, stream: true }),
      });
      expect(response.status).toBe(200);
      return response.text();
    };
    await request();
    expect(model.toolCalls).toEqual([{ name: 'DelegateStop', args: { id: child } }]);
    messages.push(
      { role: 'assistant', content: 'Calling DelegateStop.', tool_calls: [
        { id: 'stop', type: 'function', function: { name: 'DelegateStop', arguments: JSON.stringify({ id: child }) } },
      ] },
      { role: 'tool', tool_call_id: 'stop', content: 'Stopped the child.' },
    );
    expect(await request()).toContain(MARKERS.stopRecoveredAnswer);
    expect(model.toolCalls).toHaveLength(1);
  } finally {
    await model.close();
  }
});
