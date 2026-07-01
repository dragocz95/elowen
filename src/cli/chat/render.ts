import type { BrainEvent, BrainMessageView } from '../../brain/brainService.js';

/** One rendered conversation turn. `you` = the user, `orca` = the brain. */
interface ChatTurn { role: 'you' | 'orca'; text: string; tools: string[]; streaming: boolean }
/** The whole view model the TUI renders. Pure data — the reducer never touches the terminal. */
export interface ChatView { turns: ChatTurn[]; thinking: boolean }

export const emptyView = (): ChatView => ({ turns: [], thinking: false });

/** Build the initial view from stored history (user → you, everything else → orca). */
export function fromHistory(msgs: BrainMessageView[]): ChatView {
  const turns: ChatTurn[] = msgs
    .filter((m) => m.text.trim().length > 0)
    .map((m) => ({ role: m.role === 'user' ? 'you' : 'orca', text: m.text, tools: [], streaming: false }));
  return { turns, thinking: false };
}

/** Append the user's turn (finalized) — called optimistically when they hit enter. */
export function pushUser(view: ChatView, text: string): ChatView {
  return { ...view, turns: [...view.turns, { role: 'you', text, tools: [], streaming: false }] };
}

/** Open a fresh streaming assistant turn and switch on the thinking indicator. */
export function beginAssistant(view: ChatView): ChatView {
  return { thinking: true, turns: [...view.turns, { role: 'orca', text: '', tools: [], streaming: true }] };
}

/** Fold one brain event into the view. Pure: returns a new ChatView, never mutates the input. */
export function reduce(view: ChatView, e: BrainEvent): ChatView {
  const turns = view.turns.slice();
  // Return the index of a live streaming assistant turn, creating one if the last turn isn't it.
  const ensureOrca = (): number => {
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'orca' || !last.streaming) {
      turns.push({ role: 'orca', text: '', tools: [], streaming: true });
    }
    return turns.length - 1;
  };
  switch (e.type) {
    case 'text': {
      const i = ensureOrca();
      const t = turns[i]!;
      turns[i] = { ...t, text: t.text + e.delta };
      return { turns, thinking: true };
    }
    case 'tool': {
      const i = ensureOrca();
      const t = turns[i]!;
      turns[i] = { ...t, tools: [...t.tools, e.name] };
      return { turns, thinking: true };
    }
    case 'idle': {
      const i = turns.length - 1;
      const t = turns[i];
      if (t && t.role === 'orca') turns[i] = { ...t, streaming: false };
      return { turns, thinking: false };
    }
    case 'error': {
      const i = ensureOrca();
      const t = turns[i]!;
      turns[i] = { ...t, text: `${t.text}\n[chyba: ${e.message}]`, streaming: false };
      return { turns, thinking: false };
    }
    default:
      return view;
  }
}
