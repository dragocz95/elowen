import { expect, test, vi } from 'vitest';
import { MARKERS, startScriptedModel, SUBAGENT_PROMPT } from '../../scripts/tests/workflow-e2e/model.mjs';

const parentMessages = [
  { role: 'user', content: 'Stop the background child.' },
  { role: 'tool', content: 'Started background delegation dlg-12345678-abcd.\nSession: brain-ch-subagent-test' },
];
const tools = [{ type: 'function', function: { name: 'DelegateStop', parameters: { type: 'object', properties: {} } } }];

async function parentRequest(model: Awaited<ReturnType<typeof startScriptedModel>>) {
  const response = await fetch(`${model.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: parentMessages, tools, stream: true }),
  });
  expect(response.status).toBe(200);
  return response.text();
}

test('a registered child session alone cannot authorize the scripted transport-stop assertion', async () => {
  const model = await startScriptedModel({ hangReadyTimeoutMs: 30 });
  model.setMode('stop');
  try {
    const answer = await parentRequest(model);
    expect(answer).not.toContain('"name":"DelegateStop"');
    expect(answer).toContain('Error: hanging child model request is not ready');
    expect(model.hangs.requests).toBe(0);
    expect(model.hangs.aborted).toBe(0);
  } finally {
    await model.close();
  }
});

test('the scripted stop waits for a real held request and observes its actual abort', async () => {
  const model = await startScriptedModel({ hangReadyTimeoutMs: 5_000 });
  model.setMode('stop');
  const controller = new AbortController();
  let child: Promise<unknown> | undefined;
  try {
    const parent = parentRequest(model);
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    expect(model.hangs.requests).toBe(0);
    child = fetch(`${model.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ messages: [{ role: 'system', content: SUBAGENT_PROMPT }, { role: 'user', content: MARKERS.hangTask }], stream: true }),
    }).then((response) => response.text()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(model.hangs.requests).toBe(1));
    expect(await parent).toContain('"name":"DelegateStop"');
    expect(model.hangs.aborted).toBe(0);
    controller.abort();
    await child;
    await vi.waitFor(() => expect(model.hangs.aborted).toBe(1));
    expect(model.hangs.requests).toBe(1);
    expect(model.hangs.released).toBe(0);
    expect(model.hangs.stopIssuedAt).toBeGreaterThan(0);
    expect(model.hangs.abortedAt).toBeGreaterThanOrEqual(model.hangs.stopIssuedAt!);
  } finally {
    controller.abort();
    await child;
    await model.close();
  }
});
