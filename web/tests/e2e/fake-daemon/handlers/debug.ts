// The admin request-diagnostics endpoints (`/brain/debug/*`) the Settings → Data viewer reads. Canned but
// SHAPED LIKE REAL CAPTURE: a manifest carrying the semantic role/label/preview hints, per-index segment
// payloads fetched lazily, and a reconstructed raw body — so the viewer's lazy-loading and Pretty/JSON
// rendering are exercised end to end instead of against a flattened stub.
import type { Hono } from 'hono';

const SESSION_ID = 'brain-1-e2e-diagnostics';
const CAPTURE_STARTED_AT = Date.UTC(2026, 7, 20, 3, 5, 0);

const SEGMENT_PAYLOADS: Record<string, unknown[]> = {
  'req-1': [
    'You are Elowen, the personal advisor for Filip. Answer in Czech, keep it short.',
    { role: 'user', content: 'Kolik stála včerejší konverzace?' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The user asks about yesterday spend. I should query usage by day.' },
        { type: 'text', text: 'Kouknu se do usage přehledu.' },
        { type: 'tool_use', id: 'toolu_01', name: 'UsageByDay', input: { from: '2026-08-19', to: '2026-08-19' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"totalUsd":4.12,"requests":58}' }] },
    { name: 'UsageByDay', description: 'Daily spend rollup.', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from'] } },
    { name: 'MemorySearch', description: 'Search stored memories.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
    { temperature: 0, max_tokens: 8192, stream: true },
    { role: 'assistant', content: [{ type: 'text', text: 'Včera to vyšlo na 4,12 USD za 58 requestů.' }] },
  ],
  'req-2': [
    'You are Elowen, the personal advisor for Filip. Answer in Czech, keep it short.',
    { role: 'user', content: 'A rozepiš to podle modelu.' },
    { name: 'UsageByDay', description: 'Daily spend rollup.', input_schema: { type: 'object', properties: { from: { type: 'string' } } } },
    { name: 'UsageByModel', description: 'Spend grouped by model.', input_schema: { type: 'object', properties: { day: { type: 'string' } } } },
    { name: 'MemorySearch', description: 'Search stored memories.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
    { temperature: 0, max_tokens: 8192, stream: true },
  ],
};

function manifestFor(requestId: string) {
  const shared = { canonicalizationVersion: 1 };
  const rows = requestId === 'req-1'
    ? [
      { section: 'system', key: 'system', kind: 'system', role: 'system', label: 'system', preview: 'You are Elowen, the personal advisor for Filip.', byteLength: 78, estimatedTokens: 20 },
      { section: 'input', key: 'messages', kind: 'input', role: 'user', label: 'user', preview: 'Kolik stála včerejší konverzace?', byteLength: 62, estimatedTokens: 16 },
      { section: 'input', key: 'messages', kind: 'input', role: 'assistant', label: 'assistant', preview: 'Kouknu se do usage přehledu. UsageByDay {"from":"2026-08-19"}', byteLength: 240, estimatedTokens: 60 },
      { section: 'input', key: 'messages', kind: 'input', role: 'user', label: 'user', preview: '{"totalUsd":4.12,"requests":58}', byteLength: 96, estimatedTokens: 24 },
      { section: 'tool', key: 'tools', kind: 'tool', role: 'tool', label: 'UsageByDay', preview: 'Daily spend rollup.', byteLength: 180, estimatedTokens: 45 },
      { section: 'tool', key: 'tools', kind: 'tool', role: 'tool', label: 'MemorySearch', preview: 'Search stored memories.', byteLength: 150, estimatedTokens: 38 },
      { section: 'options', key: null, kind: 'options', role: 'options', label: 'options', preview: '{"temperature":0,"max_tokens":8192}', byteLength: 54, estimatedTokens: 14 },
      { section: 'response', key: null, kind: 'response', role: 'assistant', label: 'assistant', preview: 'Včera to vyšlo na 4,12 USD za 58 requestů.', byteLength: 88, estimatedTokens: 22 },
    ]
    : [
      { section: 'system', key: 'system', kind: 'system', role: 'system', label: 'system', preview: 'You are Elowen, the personal advisor for Filip.', byteLength: 78, estimatedTokens: 20 },
      { section: 'input', key: 'messages', kind: 'input', role: 'user', label: 'user', preview: 'A rozepiš to podle modelu.', byteLength: 54, estimatedTokens: 14 },
      { section: 'tool', key: 'tools', kind: 'tool', role: 'tool', label: 'UsageByDay', preview: 'Daily spend rollup.', byteLength: 160, estimatedTokens: 40 },
      { section: 'tool', key: 'tools', kind: 'tool', role: 'tool', label: 'UsageByModel', preview: 'Spend grouped by model.', byteLength: 170, estimatedTokens: 42 },
      { section: 'tool', key: 'tools', kind: 'tool', role: 'tool', label: 'MemorySearch', preview: 'Search stored memories.', byteLength: 150, estimatedTokens: 38 },
      { section: 'options', key: null, kind: 'options', role: 'options', label: 'options', preview: '{"temperature":0,"max_tokens":8192}', byteLength: 54, estimatedTokens: 14 },
    ];
  return rows.map((row, index) => ({ ...shared, ...row, index, digest: `${requestId}-${index}-3f8a2c` }));
}

const REQUESTS = [
  {
    requestId: 'req-1', sessionId: SESSION_ID, seq: 1, turnId: 'turn-1', retryOf: null, kind: 'chat',
    configuredProvider: 'anthropic', wireProvider: 'anthropic', api: 'anthropic-messages', model: 'claude-opus-5',
    startedAt: CAPTURE_STARTED_AT, responseAt: CAPTURE_STARTED_AT + 900, finishedAt: CAPTURE_STARTED_AT + 4200,
    status: 'succeeded', httpStatus: 200, errorCode: null, errorMessage: null,
    inputTokens: 12480, outputTokens: 320, reasoningTokens: 180, cacheReadTokens: 11200, cacheWriteTokens: 640,
    totalTokens: 13120, costUsd: 0.0412, durationMs: 4200,
  },
  {
    requestId: 'req-2', sessionId: SESSION_ID, seq: 2, turnId: 'turn-2', retryOf: null, kind: 'chat',
    configuredProvider: 'anthropic', wireProvider: 'anthropic', api: 'anthropic-messages', model: 'claude-opus-5',
    startedAt: CAPTURE_STARTED_AT + 60_000, responseAt: null, finishedAt: CAPTURE_STARTED_AT + 61_500,
    status: 'error', httpStatus: 529, errorCode: 'overloaded_error', errorMessage: 'Provider is temporarily overloaded.',
    inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    totalTokens: null, costUsd: null, durationMs: 1500,
  },
];

const SESSIONS = [
  {
    id: SESSION_ID, userId: 1, username: 'admin', userName: 'Filip', title: 'Účet za včerejšek',
    surface: 'conversation', provider: 'anthropic', model: 'claude-opus-5',
    createdAt: '2026-08-20 03:00:00', updatedAt: '2026-08-20 03:06:00',
    captureStartedAt: CAPTURE_STARTED_AT, requestCount: 2, errorCount: 1,
    firstRequestAt: CAPTURE_STARTED_AT, lastRequestAt: CAPTURE_STARTED_AT + 61_500,
    inputTokens: 12480, outputTokens: 320, reasoningTokens: 180, cacheReadTokens: 11200, cacheWriteTokens: 640,
    totalTokens: 13120, costUsd: 0.0412, costedRequestCount: 1, latestRequestStatus: 'error',
  },
  {
    id: 'brain-ch-msteams-legacy', userId: 1, username: 'admin', userName: 'Filip', title: 'Starší kanál',
    surface: 'channel', provider: 'anthropic', model: 'claude-sonnet-5',
    createdAt: '2026-08-12 09:00:00', updatedAt: '2026-08-12 09:40:00',
    captureStartedAt: null, requestCount: 0, errorCount: 0, firstRequestAt: null, lastRequestAt: null,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 0, costUsd: 0, costedRequestCount: 0, latestRequestStatus: null,
  },
];

export function registerDebugRoutes(app: Hono): void {
  app.get('/brain/debug/sessions', (c) => {
    const search = (c.req.query('search') ?? '').toLowerCase();
    const items = search ? SESSIONS.filter((s) => s.title.toLowerCase().includes(search)) : SESSIONS;
    return c.json({ items, nextCursor: null, captureStartedAt: CAPTURE_STARTED_AT });
  });

  app.get('/brain/debug/sessions/:id/requests', (c) =>
    c.req.param('id') === SESSION_ID
      ? c.json({ items: REQUESTS, nextCursor: null })
      : c.json({ items: [], nextCursor: null }));

  app.get('/brain/debug/sessions/:id/requests/:requestId', (c) => {
    const request = REQUESTS.find((item) => item.requestId === c.req.param('requestId'));
    if (!request) return c.json({ error: 'not found' }, 404);
    const segments = manifestFor(request.requestId);
    return c.json({
      ...request, canonicalizationVersion: 1, assistantMessageId: null, segments,
      segmentBytes: segments.filter((s) => s.section !== 'response').reduce((sum, s) => sum + s.byteLength, 0),
    });
  });

  app.get('/brain/debug/sessions/:id/requests/:requestId/segments/:index', (c) => {
    const requestId = c.req.param('requestId');
    const index = Number(c.req.param('index'));
    const manifest = manifestFor(requestId)[index];
    const payload = SEGMENT_PAYLOADS[requestId]?.[index];
    if (!manifest || payload === undefined) return c.json({ error: 'not found' }, 404);
    return c.json({ ...manifest, payload });
  });

  app.get('/brain/debug/sessions/:id/requests/:requestId/raw', (c) => {
    const requestId = c.req.param('requestId');
    const payloads = SEGMENT_PAYLOADS[requestId];
    if (!payloads) return c.json({ error: 'not found' }, 404);
    const manifest = manifestFor(requestId);
    const pick = (section: string) => manifest.flatMap((row, index) => row.section === section ? [payloads[index]] : []);
    return c.json({
      payload: {
        model: 'claude-opus-5', system: pick('system')[0], messages: pick('input'),
        tools: pick('tool'), ...(pick('options')[0] as Record<string, unknown>),
      },
      byteLength: 2048,
    });
  });

  app.get('/brain/debug/sessions/:id/legacy-transcript', (c) => c.json({
    items: [
      { cursor: 1, id: 'legacy-1', role: 'user', content: 'Starší zpráva bez přesného záznamu.', createdAt: '2026-08-12 09:10:00', byteLength: 48 },
      { cursor: 2, id: 'legacy-2', role: 'assistant', content: 'Odpověď z doby před zachytáváním requestů.', createdAt: '2026-08-12 09:10:40', byteLength: 56 },
    ],
    nextCursor: null, loadedBytes: 104, exact: false,
  }));
}
