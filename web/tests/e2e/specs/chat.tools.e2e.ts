// P0-4 — tool-call rendering across the real EventSource → reducer pipeline. A tool pill shows its icon +
// argument detail, an edit's `diff` frame renders a diff block inside its pill, and a completed tool's
// `tool_output` result block streams LIVE into its pill (superseding the live `tool_progress` tail). The
// whole sequence folds into ONE assistant turn.
//
// The BrainChatProvider wires the live SSE listeners `tool`, `tool_progress`, `diff` AND `tool_output`
// (the last added in the #118 rendering-parity fix — the reducer already folded `tool_output`, only the
// EventSource subscription was missing, so a finished tool's stand-alone output block now renders live
// rather than only after a history reload). A bare `tool_end` (a tool that finishes with no displayable
// block) has no reducer case in either the web or daemon transcript mirror, so it is intentionally not
// wired — folding it would be a no-op.
import { test, expect, ChatPage } from '../fixtures/index.ts';

test('@smoke P0-4 tool calls render a pill and an edit streams a diff block', async ({ app, seed, sse }) => {
  await seed.messages([]);

  const chat = new ChatPage(app);
  await chat.goto();

  const readId = 'call-read-1';

  // A Read tool starts — a bare pill with icon + detail (no diff/output, so a simple non-collapsible row).
  await sse.tool({ name: 'Read', detail: 'src/app.ts', icon: '📖', id: readId });
  const readPill = chat.toolPill(readId);
  await expect(readPill).toBeVisible();
  await expect(readPill).toContainText('Read');
  await expect(readPill).toContainText('src/app.ts');
  await expect(readPill).toContainText('📖');

  // An Edit tool with a diff — the `diff` frame folds onto its pill (a collapsible <details>).
  const editId = 'call-edit-1';
  await sse.tool({ name: 'Edit', detail: 'src/app.ts', icon: '✏️', id: editId });
  await sse.diff('- const answer = 42;\n+ const answer = 43;', { id: editId });
  const editPill = chat.toolPill(editId);
  await expect(editPill).toBeVisible();
  await editPill.locator('summary').click();
  await expect(editPill).toContainText('const answer = 43;');

  // A Bash tool streams a live progress tail, then its completed `tool_output` block supersedes the tail and
  // renders LIVE inside the (now expandable) pill — the #118 parity behavior, previously only shown on reload.
  const bashId = 'call-bash-1';
  await sse.tool({ name: 'Bash', detail: 'npm run build', icon: '⚡', id: bashId });
  await sse.toolProgress(bashId, 'compiling…');
  await sse.toolOutput({ title: 'Bash', kind: 'console', text: 'build succeeded', command: 'npm run build' }, bashId);
  const bashPill = chat.toolPill(bashId);
  await expect(bashPill).toBeVisible();
  await bashPill.locator('summary').click();
  const bashOut = chat.toolOutput(bashId);
  await expect(bashOut).toBeVisible();
  await expect(bashOut).toContainText('build succeeded');
  await expect(bashOut).toContainText('npm run build');
  // The final output supersedes the live progress tail (no doubled dump) — the tail is gone from the pill.
  await expect(bashPill).not.toContainText('compiling…');

  // A closing text segment lands in the SAME assistant turn, then the turn ends.
  await sse.text('Updated the constant.');
  await sse.idle();

  await expect(chat.turnsByRole('assistant')).toHaveCount(1);
  await expect(chat.turnsByRole('assistant')).toContainText('Updated the constant.');
  await expect(chat.toolPills()).toHaveCount(3);
});
