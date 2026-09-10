/** THE HOST'S IMAGE CLIENT — one place where an image request becomes an HTTP call.
 *
 *  The image plugins used to hold their own `fetch` against `${baseUrl}/images/generations` with a Bearer
 *  API key, which made an OAuth account structurally unusable: a ChatGPT login has no static key, its
 *  images answer on a different endpoint (`chatgpt.com/backend-api/codex/images/*`) with Codex identity
 *  headers, and the access token behind it must never reach plugin code. So the transport lives here and
 *  plugins call `ctx.images`, which hands back rendered PNG bytes and usage — never a credential.
 *
 *  Two transports, one contract:
 *   - an API-key provider keeps the OpenAI-compatible Images API (JSON for generations, multipart for
 *     edits, exactly what the plugins sent before);
 *   - `oauth-openai-codex` posts JSON to the ChatGPT backend with the token pi refreshed, the account id
 *     from the credential (or the token's own claim), and the headers the Codex CLI sends.
 *
 *  The ChatGPT backend renders whatever model string it is given — a typo bills a nonexistent model
 *  instead of failing — so the account's model ids are validated HERE against {@link OPENAI_CODEX_IMAGE_MODELS}.
 */
import { randomUUID } from 'node:crypto';
import { arch, platform } from 'node:os';
import type {
  PluginImageEditRequest, PluginImageRequest, PluginImageResult, PluginImageSource, PluginImages, ProviderCredentials,
} from '../plugins/api.js';
import type { BrainCredentialAccess } from './providerUsage.js';
import { accountIdFromToken } from './session/remoteCompactionV2.js';
import { OAUTH_BUILTIN } from './providers.js';
import { trimAllTrailingSlashes } from '../shared/url.js';

/** Image models the connected ChatGPT (Codex) account serves on `codex/images/*`. They are NOT chat
 *  models — the Responses API rejects them — so they live here rather than in the chat catalog, and this
 *  list is what the settings field's model id is checked against. */
export const OPENAI_CODEX_IMAGE_MODELS = [
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
  'gpt-image-2',
  'gpt-image-1.5',
] as const;

/** Whether a configured provider's model id names an IMAGE model rather than a chat model. The account
 *  model list carries both, marked apart by `BrainModelOption.kind`, so the same allowlist decides what
 *  an image plugin may pick.
 *
 *  The ChatGPT account has the fixed catalog above, and that list is also what a stored id is validated
 *  against. An API-key OpenAI endpoint needs no catalog of its own: it already advertises its image
 *  models in the same `/models` answer as its chat models, and OpenAI names every one of them
 *  `gpt-image-*`, so that prefix is the recognition rule there. */
export function isImageModelId(providerType: string, id: string): boolean {
  if (providerType === 'oauth-openai-codex') return (OPENAI_CODEX_IMAGE_MODELS as readonly string[]).includes(id);
  return providerType === 'openai' && id.startsWith('gpt-image');
}

/** The image models a connected OAuth account of `type` serves, for the account's model allowlist. */
export function oauthImageCatalog(type: string): string[] {
  return type === 'oauth-openai-codex' ? [...OPENAI_CODEX_IMAGE_MODELS] : [];
}

/** Image models are slow; a generation regularly takes tens of seconds. */
const DEFAULT_TIMEOUT_MS = 120_000;

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** The Codex CLI build the ChatGPT image backend is served to. Sent verbatim as `originator`, and as the
 *  product half of the user agent, because that is the identity the endpoint was verified against. */
const CODEX_ORIGINATOR = 'codex_cli_rs';
const CODEX_CLI_VERSION = '0.109.0';

/** A failed image request, with the transport's own status and (bounded) detail so the tool can say what
 *  the provider actually answered instead of "request failed". */
export class ImageRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly detail?: string) {
    super(status ? `${message} (HTTP ${status})${detail ? `: ${detail}` : ''}` : message);
    this.name = 'ImageRequestError';
  }
}

export interface ImageServiceDeps {
  /** The central provider resolver (`brainCore.resolveProvider`) — live config on every call. */
  resolveProvider: (id: string) => ProviderCredentials | null;
  /** The brain's credential access: `getApiKey` runs pi's own refresh-and-persist path. */
  credentials: BrainCredentialAccess;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MIME_TO_EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** The Codex images base: an operator base may already carry the `/codex` prefix, mirroring pi-ai's own
 *  URL resolution for the responses endpoint. */
export function codexImagesUrl(baseUrl: string | undefined, path: 'generations' | 'edits'): string {
  const raw = baseUrl && baseUrl.trim() ? baseUrl.trim() : DEFAULT_CODEX_BASE_URL;
  const normalized = trimAllTrailingSlashes(raw);
  const base = normalized.endsWith('/codex') ? normalized : `${normalized}/codex`;
  return `${base}/images/${path}`;
}

function parseImageResponse(model: string, raw: unknown): PluginImageResult {
  const body = (raw ?? {}) as Record<string, unknown>;
  const first = Array.isArray(body.data) ? (body.data[0] as Record<string, unknown> | undefined) : undefined;
  const b64 = typeof first?.b64_json === 'string' ? first.b64_json : '';
  if (!b64) throw new ImageRequestError('the image provider returned no image');
  const usageRaw = (body.usage ?? null) as Record<string, unknown> | null;
  const details = (usageRaw?.output_tokens_details ?? null) as Record<string, unknown> | null;
  return {
    png: Buffer.from(b64, 'base64'),
    model,
    size: stringOrNull(body.size),
    quality: stringOrNull(body.quality),
    format: stringOrNull(body.output_format),
    usage: usageRaw
      ? {
        inputTokens: finiteOrNull(usageRaw.input_tokens),
        outputTokens: finiteOrNull(usageRaw.output_tokens),
        imageTokens: finiteOrNull(details?.image_tokens),
      }
      : null,
  };
}

export class ImageService implements PluginImages {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ImageServiceDeps) {
    this.doFetch = deps.fetchImpl ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  generate(req: PluginImageRequest): Promise<PluginImageResult> {
    return this.run(req, null);
  }

  edit(req: PluginImageEditRequest): Promise<PluginImageResult> {
    if (!req.images?.length) return Promise.reject(new ImageRequestError('an edit needs at least one source image'));
    return this.run(req, req.images);
  }

  private async run(req: PluginImageRequest, images: PluginImageSource[] | null): Promise<PluginImageResult> {
    const prompt = req.prompt?.trim() ?? '';
    if (!prompt) throw new ImageRequestError('a prompt is required');
    const provider = this.deps.resolveProvider(req.providerId);
    if (!provider) throw new ImageRequestError(`no configured provider '${req.providerId}'`);
    const model = req.model?.trim() ?? '';
    if (!model) throw new ImageRequestError('a model id is required');
    return provider.type === 'oauth-openai-codex'
      ? this.viaCodexAccount(provider, { ...req, prompt, model }, images)
      : this.viaImagesApi(provider, { ...req, prompt, model }, images);
  }

  /** The ChatGPT account: JSON on `codex/images/*`, Codex identity headers, pi's refreshed token. */
  private async viaCodexAccount(provider: ProviderCredentials, req: PluginImageRequest, images: PluginImageSource[] | null): Promise<PluginImageResult> {
    if (!(OPENAI_CODEX_IMAGE_MODELS as readonly string[]).includes(req.model)) {
      throw new ImageRequestError(`'${req.model}' is not an image model of the ChatGPT account (expected one of ${OPENAI_CODEX_IMAGE_MODELS.join(', ')})`);
    }
    const credentialKey = OAUTH_BUILTIN[provider.type] ?? provider.type;
    const token = await this.deps.credentials.getApiKey(credentialKey);
    if (!token) throw new ImageRequestError(`the ${provider.label} account is not connected`);
    const stored = this.deps.credentials.get(credentialKey) as { accountId?: unknown } | undefined;
    const accountId = (typeof stored?.accountId === 'string' && stored.accountId.trim() ? stored.accountId.trim() : null)
      ?? accountIdFromToken(token);
    if (!accountId) throw new ImageRequestError(`the ${provider.label} credential carries no ChatGPT account id`);

    const body: Record<string, unknown> = {
      ...(images ? { images: images.map((image) => ({ image_url: dataUrl(image) })) } : {}),
      prompt: req.prompt,
      model: req.model,
      n: req.n ?? 1,
      ...(req.quality ? { quality: req.quality } : {}),
      ...(req.size ? { size: req.size } : {}),
      ...(req.background ? { background: req.background } : {}),
    };
    const res = await this.send(codexImagesUrl(provider.baseUrl, images ? 'edits' : 'generations'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'chatgpt-account-id': accountId,
        originator: CODEX_ORIGINATOR,
        'user-agent': `${CODEX_ORIGINATOR}/${CODEX_CLI_VERSION} (${platform()} ${arch()})`,
        'session-id': randomUUID(),
        'x-codex-image-turn-id': randomUUID(),
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }, req.signal);
    return parseImageResponse(req.model, await res.json());
  }

  /** An API-key endpoint: the OpenAI-compatible Images API, unchanged from what the plugins sent. */
  private async viaImagesApi(provider: ProviderCredentials, req: PluginImageRequest, images: PluginImageSource[] | null): Promise<PluginImageResult> {
    if (!provider.apiKey) throw new ImageRequestError(`the provider '${provider.id}' has no API key configured`);
    const base = trimAllTrailingSlashes(provider.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL);
    const url = `${base}/images/${images ? 'edits' : 'generations'}`;
    // Edits go as multipart (the Images API takes the source as a file part), generations as JSON.
    const init: RequestInit = images
      ? { method: 'POST', headers: { authorization: `Bearer ${provider.apiKey}` }, body: editForm(req, images) }
      : {
        method: 'POST',
        headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: req.prompt,
          model: req.model,
          n: req.n ?? 1,
          ...(req.quality ? { quality: req.quality } : {}),
          ...(req.size ? { size: req.size } : {}),
          ...(req.background ? { background: req.background } : {}),
        }),
      };
    const res = await this.send(url, init, req.signal);
    return parseImageResponse(req.model, await res.json());
  }

  /** One bounded request with the provider's own failure surfaced as a structured error. */
  private async send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.doFetch(url, {
      ...init,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ImageRequestError('the image request was rejected', res.status, detail.slice(0, 300));
    }
    return res;
  }
}

/** A source image as the data URL the Codex backend expects. */
function dataUrl(image: PluginImageSource): string {
  const mime = image.mime?.trim() || 'image/png';
  return `data:${mime};base64,${Buffer.from(image.bytes).toString('base64')}`;
}

function editForm(req: PluginImageRequest, images: PluginImageSource[]): FormData {
  const form = new FormData();
  form.set('model', req.model);
  form.set('prompt', req.prompt);
  if (req.size) form.set('size', req.size);
  if (req.quality) form.set('quality', req.quality);
  if (req.background) form.set('background', req.background);
  for (const image of images) {
    const mime = image.mime?.trim() || 'image/png';
    form.append('image', new Blob([image.bytes as BlobPart], { type: mime }), `source.${MIME_TO_EXTENSION[mime] ?? 'png'}`);
  }
  return form;
}
