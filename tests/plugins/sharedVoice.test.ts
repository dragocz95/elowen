import { describe, it, expect, afterEach, vi } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { voiceCreds, transcribeBuffer } from '../../packages/plugin-shared/voice.mjs';

describe('shared plugin voice helpers', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('voiceCreds', () => {
    const provider = { apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1' };

    it('resolves the configured provider to its key and audio base url', () => {
      expect(voiceCreds({ voiceProvider: 'openai' }, () => provider))
        .toEqual({ apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1' });
    });

    it('trims the configured id and the base url trailing slashes, so endpoints concatenate cleanly', () => {
      const resolve = vi.fn(() => ({ apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1//' }));
      expect(voiceCreds({ voiceProvider: '  openai  ' }, resolve).baseUrl).toBe('https://api.example.com/v1');
      expect(resolve).toHaveBeenCalledWith('openai');
    });

    it('is null when voice is not configured — the caller then notes the clip instead of transcribing', () => {
      const resolve = vi.fn(() => provider);
      expect(voiceCreds({}, resolve)).toBeNull();
      expect(voiceCreds({ voiceProvider: '   ' }, resolve)).toBeNull();
      expect(voiceCreds({ voiceProvider: 42 }, resolve)).toBeNull();
      expect(resolve).not.toHaveBeenCalled(); // no id → the provider is never looked up
    });

    it('is null for a provider that is unknown or carries no usable credentials', () => {
      expect(voiceCreds({ voiceProvider: 'nope' }, () => null)).toBeNull();
      expect(voiceCreds({ voiceProvider: 'nokey' }, () => ({ baseUrl: 'https://x/v1' }))).toBeNull();
      expect(voiceCreds({ voiceProvider: 'nourl' }, () => ({ apiKey: 'sk-test' }))).toBeNull();
    });
  });

  describe('transcribeBuffer', () => {
    const creds = { apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1' };

    function stubFetch(body: unknown, status = 200) {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('posts the clip to the provider transcription endpoint and returns the trimmed text', async () => {
      const fetchMock = stubFetch({ text: '  ahoj světe \n' });
      const out = await transcribeBuffer(creds, Buffer.from('audio'), { name: 'clip.ogg', type: 'audio/ogg', model: 'whisper-large' });
      expect(out).toBe('ahoj světe');

      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://api.example.com/v1/audio/transcriptions');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
      const form = init.body as FormData;
      expect(form.get('model')).toBe('whisper-large');
      expect((form.get('file') as File).name).toBe('clip.ogg');
      expect((form.get('file') as File).type).toBe('audio/ogg');
    });

    it('falls back to whisper-1 and an ogg clip name when the caller has no configured values', async () => {
      const fetchMock = stubFetch({ text: 'ok' });
      await transcribeBuffer(creds, Buffer.from('audio'), {});
      const form = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
      expect(form.get('model')).toBe('whisper-1');
      expect((form.get('file') as File).name).toBe('audio.ogg');
      expect((form.get('file') as File).type).toBe('audio/ogg');
      await expect(transcribeBuffer(creds, Buffer.from('audio'))).resolves.toBe('ok');
    });

    it('is null when the provider transcribed nothing usable, so the caller keeps the turn text-only', async () => {
      stubFetch({ text: '   ' });
      await expect(transcribeBuffer(creds, Buffer.from('a'), {})).resolves.toBeNull();
      stubFetch({});
      await expect(transcribeBuffer(creds, Buffer.from('a'), {})).resolves.toBeNull();
      stubFetch({ text: 7 });
      await expect(transcribeBuffer(creds, Buffer.from('a'), {})).resolves.toBeNull();
    });

    it('throws a failure carrying the status and body, so the adapter can log it and fall back to a note', async () => {
      stubFetch({ error: 'nope' }, 401);
      const err = await transcribeBuffer(creds, Buffer.from('a'), {}).catch((e: unknown) => e) as { status: number; data: unknown; message: string };
      expect(err.status).toBe(401);
      expect(err.data).toEqual({ error: 'nope' });
      expect(err.message).toContain('401');
    });

    it('does not send the clip twice when the provider is briefly unavailable', async () => {
      const fetchMock = stubFetch({ error: 'busy' }, 503);
      await transcribeBuffer(creds, Buffer.from('a'), {}).catch(() => undefined);
      // Retrying a POST would bill (and possibly transcribe) the same clip again.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not blow up on a non-JSON success body', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
      await expect(transcribeBuffer(creds, Buffer.from('a'), {})).resolves.toBeNull();
    });
  });
});
