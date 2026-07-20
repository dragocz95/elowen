/** User-facing service messages, per configured language (config `language`: 'en' | 'cs'). These are
 *  the bot's own texts (command replies, placeholders) — the brain's answers are in the user's language.
 *  Surface-neutral keys and the `/help` command wording live in ../../_shared; WhatsApp-specific texts
 *  (`*bold*` emphasis, numbered-reply prompts) stay here. */
import { SHARED_MESSAGES } from '../../_shared/messages.mjs';
import { renderHelpLines } from '../../_shared/help.mjs';

// The commands WhatsApp lists in /help, in display order. WhatsApp has no /voice or /display surface.
const HELP_CMDS = ['model', 'context', 'reasoning', 'fast', 'new', 'stop', 'status', 'compact', 'restart', 'help'];
const mono = (s) => '`' + s + '`';

export const MESSAGES = {
  en: {
    ...SHARED_MESSAGES.en,
    newConversation: '🆕 Fresh conversation started in this chat.',
    pickModel: '🧠 Pick the model for this chat',
    modelSet: (m) => `✅ Model set to *${m}*.`,
    pickContext: '💬 Continue this chat in one of your conversations',
    contextBound: (title) => `🔗 This chat now continues *${title || 'your conversation'}*.`,
    pagePrev: '⬅️ Previous page',
    pageNext: '➡️ Next page',
    pickThinking: '🧠 Pick the reasoning effort for this chat',
    reasoningDefault: 'model default',
    thinkingSet: (l) => `✅ Reasoning effort set to *${l}*.`,
    fastSet: (on) => on ? '⚡ Fast mode is *on* for this chat.' : '🐢 Fast mode is *off* for this chat.',
    fastUsage: 'Usage: `/fast`, `/fast on`, or `/fast off`.',
    nothingRunning: '💤 Nothing is running in this chat.',
    noSession: '💤 No active conversation in this chat yet.',
    status: (model, pct, tokens) => `🧠 *${model}*\n📊 Context ${pct}% · ${tokens} tokens`,
    replyWithNumber: (n) => n > 1 ? `Reply with a number (1-${n}).` : 'Reply with the number.',
    replyWithNumbers: (n) => `Reply with a number (1-${n}), or several separated by commas (e.g. 1,3).`,
    submitHint: 'Reply *submit* when done, or send your own answer as text.',
    expired: '⏱ This prompt expired.',
    otherHint: 'Or just type your own answer.',
    help: (name) => [
      `*${name} on WhatsApp*`,
      'Write to me and I answer.',
      '',
      ...renderHelpLines({ lang: 'en', commands: HELP_CMDS, mono, place: 'chat' }),
    ].join('\n'),
  },
  cs: {
    ...SHARED_MESSAGES.cs,
    newConversation: '🆕 V tomto chatu začíná nová konverzace.',
    pickModel: '🧠 Vyberte model pro tento chat',
    modelSet: (m) => `✅ Model nastaven na *${m}*.`,
    pickContext: '💬 Navažte v tomto chatu na jednu ze svých konverzací',
    contextBound: (title) => `🔗 Tento chat nyní pokračuje v konverzaci *${title || 'vaší konverzaci'}*.`,
    pagePrev: '⬅️ Předchozí strana',
    pageNext: '➡️ Další strana',
    pickThinking: '🧠 Vyberte úroveň uvažování pro tento chat',
    reasoningDefault: 'výchozí nastavení modelu',
    thinkingSet: (l) => `✅ Úroveň uvažování nastavena na *${l}*.`,
    fastSet: (on) => on ? '⚡ Fast režim je pro tento chat *zapnutý*.' : '🐢 Fast režim je pro tento chat *vypnutý*.',
    fastUsage: 'Použití: `/fast`, `/fast on` nebo `/fast off`.',
    nothingRunning: '💤 V tomto chatu nic neběží.',
    noSession: '💤 V tomto chatu zatím není žádná aktivní konverzace.',
    status: (model, pct, tokens) => `🧠 *${model}*\n📊 Kontext ${pct}% · ${tokens} tokenů`,
    replyWithNumber: (n) => n > 1 ? `Odpověz číslem (1-${n}).` : 'Odpověz tím číslem.',
    replyWithNumbers: (n) => `Odpověz číslem (1-${n}), nebo více čísly oddělenými čárkou (např. 1,3).`,
    submitHint: 'Až budeš hotov, napiš *submit*, nebo pošli vlastní odpověď textem.',
    expired: '⏱ Tento dotaz vypršel.',
    otherHint: 'Nebo napiš vlastní odpověď.',
    help: (name) => [
      `*${name} na WhatsAppu*`,
      'Napiš mi a odpovím.',
      '',
      ...renderHelpLines({ lang: 'cs', commands: HELP_CMDS, mono, place: 'chat', placeLoc: 'chatu' }),
    ].join('\n'),
  },
};
