const TOOL_ACTIVITY = new Set(['off', 'status', 'live']);
const ANSWER_MODES = new Set(['final', 'live']);
const TOOL_OUTPUT = new Set(['hidden', 'summary', 'tail']);
const TOOL_MESSAGE_MODES = new Set(['single', 'per_tool']);

function pick(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

/** Resolve the Telegram presentation policy for one chat. New enum settings win; old booleans remain
 *  a read-only fallback so existing installations keep their behaviour until the operator saves the new
 *  fields. A chat may override any axis independently through `/display`; absent axes inherit global. */
export function resolveDisplaySettings(cfg = {}, channelState = {}) {
  const channel = channelState?.display ?? {};
  const hasLegacyAnswerConfig = Object.hasOwn(cfg, 'streaming') || Object.hasOwn(cfg, 'streamAnswer');
  const legacyTools = cfg.streaming === false ? 'off' : 'status';
  const legacyAnswer = hasLegacyAnswerConfig
    ? (cfg.streaming === false || cfg.streamAnswer === false ? 'final' : 'live')
    : 'final';
  const globalTools = pick(cfg.toolActivity, TOOL_ACTIVITY, legacyTools);
  const globalAnswer = pick(cfg.answerMode, ANSWER_MODES, legacyAnswer);
  const globalOutput = pick(cfg.toolOutput, TOOL_OUTPUT, 'summary');
  const globalToolMessageMode = pick(cfg.toolMessageMode, TOOL_MESSAGE_MODES, 'single');
  return {
    toolActivity: pick(channel.toolActivity, TOOL_ACTIVITY, globalTools),
    answerMode: pick(channel.answerMode, ANSWER_MODES, globalAnswer),
    toolOutput: pick(channel.toolOutput, TOOL_OUTPUT, globalOutput),
    toolMessageMode: pick(channel.toolMessageMode, TOOL_MESSAGE_MODES, globalToolMessageMode),
  };
}

/** Apply optional `/display` values. `default` clears only that chat override; omitted axes are kept. */
export function updateDisplayOverrides(current = {}, values = {}) {
  const next = { ...current };
  for (const [key, allowed] of [['toolActivity', TOOL_ACTIVITY], ['answerMode', ANSWER_MODES], ['toolOutput', TOOL_OUTPUT], ['toolMessageMode', TOOL_MESSAGE_MODES]]) {
    const value = values[key];
    if (value === undefined) continue;
    if (value === 'default') delete next[key];
    else if (allowed.has(value)) next[key] = value;
  }
  return next;
}
