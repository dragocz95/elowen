import type { MarkdownTheme } from '@earendil-works/pi-tui';
import { ChatApplication } from './chatApplication.js';
import type { ChatRuntime } from './runtime.js';
import type { StreamController } from './streamController.js';
import type { TuiDiagnostics } from './tuiDiagnostics.js';

export {
  bottomHints,
  INTERRUPT_CONFIRM_MS,
  interruptPress,
  quitHint,
  startScreenHints,
  statusline,
} from './chatComposition.js';

/** Stable legacy factory boundary until Task 7 replaces the outer runChat graph. ChatApplication now
 * constructs and owns the production composition; this module deliberately contains no layout state. */
export function createShell(
  rt: ChatRuntime,
  stream: StreamController,
  mdTheme: MarkdownTheme,
  diagnostics: TuiDiagnostics,
): ChatApplication {
  return new ChatApplication({ rt, stream, mdTheme, diagnostics });
}
