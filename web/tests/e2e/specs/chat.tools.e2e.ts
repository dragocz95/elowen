// P0-4 — tool-call rendering across the real EventSource → reducer pipeline. A tool pill shows its icon +
// argument detail, and an edit's `diff` frame renders a diff block inside its pill. The whole sequence
// (tool → diff → text → idle) folds into ONE assistant turn.
//
// NOTE on scope: the web BrainChatProvider wires the live SSE listeners `tool`, `tool_progress` and `diff`
// — but NOT `tool_end` or `tool_output`, so a completed tool's stand-alone output block is not streamed
// live into the web chat today (it only appears after a history reload, from the stored message segment).
// That live-parity gap is tracked separately (transcript rendering parity), so this smoke asserts the
// behavior the product actually streams live: the pill and the diff. It intentionally does not assert a
// live `tool_output` block — that would test behavior the web provider does not implement.
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

  // A closing text segment lands in the SAME assistant turn, then the turn ends.
  await sse.text('Updated the constant.');
  await sse.idle();

  await expect(chat.turnsByRole('assistant')).toHaveCount(1);
  await expect(chat.turnsByRole('assistant')).toContainText('Updated the constant.');
  await expect(chat.toolPills()).toHaveCount(2);
});
