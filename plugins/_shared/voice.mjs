// Voice plumbing shared by the adapters that support spoken turns (Discord, Telegram): resolving the
// configured voice provider's credentials and posting an audio buffer to its Whisper-compatible endpoint.
// Acquiring the buffer stays per-adapter (a Discord CDN download versus a Telegram getFile), and so does
// speakReply — the surfaces want different containers (mp3 versus OGG/Opus).
import { createHttpClient } from './httpClient.mjs';

/** Resolve the voice provider's credentials (a central brain provider chosen in config) → { apiKey,
 *  baseUrl }, or null when unset/keyless. baseUrl carries the audio endpoints (e.g. …/v1). */
export function voiceCreds(cfg, resolveProvider) {
  const id = typeof cfg.voiceProvider === 'string' ? cfg.voiceProvider.trim() : '';
  if (!id) return null;
  const p = resolveProvider(id);
  if (!p?.apiKey || !p.baseUrl) return null;
  return { apiKey: p.apiKey, baseUrl: String(p.baseUrl).replace(/\/+$/, '') };
}

/** How long a transcription may take before we give up. A voice clip is minutes of audio at worst, but a
 *  provider that never answers must not hold the turn open forever — which a bare `fetch` would. */
const STT_TIMEOUT_MS = 60_000;

/** Transcribe one audio buffer: multipart it to the provider's /audio/transcriptions. Returns the trimmed
 *  text, or null when the provider answers with nothing usable. Throws (an {@link HttpError}, carrying the
 *  status and body) on a failed request so the caller can log it and fall back to a note. The request is
 *  never retried: a POST that may have been received once must not be sent twice. */
export async function transcribeBuffer(creds, buf, { name, type, model } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: type || 'audio/ogg' }), name || 'audio.ogg');
  form.append('model', String(model || 'whisper-1'));
  const api = createHttpClient({
    baseUrl: creds.baseUrl,
    headers: { authorization: `Bearer ${creds.apiKey}` },
    timeoutMs: STT_TIMEOUT_MS,
  });
  const res = await api.post('/audio/transcriptions', form);
  const t = typeof res.data?.text === 'string' ? res.data.text.trim() : '';
  return t || null;
}
