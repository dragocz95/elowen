import { downscaleImage } from '../../lib/imageDownscale';

/** A staged attachment: images travel as base64 to the model's vision input; text files get their
 *  content inlined into the message (fenced), which works with any model. */
export interface Attachment { name: string; kind: 'image' | 'text'; mimeType: string; data: string; preview?: string }

export const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
/** What the vision providers actually decode (Anthropic: png/jpeg/gif/webp) — mirrors imageSchema in
 *  src/api/schemas/brain.ts and cli/chat/mentions.ts' IMAGE_MIME_BY_EXT. A browser reports plenty of
 *  other "image/*" types (heic, bmp, avif, svg…) that pass this prefix but that the provider cannot
 *  decode — forwarding one gets an opaque "Could not process image" 400 instead of a clear local error. */
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** The same four types keyed by extension. A browser does NOT always report a type: a file dragged from
 *  certain apps, or one the OS has no association for, arrives with `type: ''`. Without this it fell
 *  through to the text branch, was read as text, hit a NUL byte and was rejected as "binary" — a perfectly
 *  ordinary PNG refused with a message about the wrong thing entirely. */
const IMAGE_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

/** Why an attachment was refused. Distinct values because the two need different messages: one is fixed
 *  by sending a smaller file, the other by converting it — and a single message for both told the user
 *  neither. */
export type AttachRefusal = 'too-large' | 'unsupported';

/** The image type to send this file as, or null when it is not an image we can forward. */
export function imageTypeOf(file: File): string | null {
  if (file.type.startsWith('image/')) return SUPPORTED_IMAGE_TYPES.has(file.type) ? file.type : null;
  if (file.type) return null; // a declared non-image type — text branch
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_TYPE_BY_EXTENSION[ext] ?? null;
}

export async function readAttachment(file: File): Promise<Attachment | AttachRefusal> {
  const imageType = imageTypeOf(file);
  // Anything the browser calls an image is judged as one even when we cannot forward it, so an unusable
  // type (heic, avif, svg…) is named as such instead of being read as text and reported as binary.
  if (imageType || file.type.startsWith('image/')) {
    // A phone photo is routinely bigger than the provider accepts, and always has more pixels than it
    // keeps; a phone photo may also be in a format the provider cannot read at all (heic). Both are
    // handled by re-encoding here rather than refusing, because on a phone the user cannot convert or
    // resize anything by hand. Null means it was not needed, or the engine could not decode it either —
    // then the original is judged exactly as before.
    const smaller = await downscaleImage(file, {
      maxBytes: MAX_IMAGE_BYTES,
      sourceType: imageType ?? file.type,
      mustConvert: !imageType,
    }).catch(() => null);
    if (!imageType && !smaller) return 'unsupported';
    const source: Blob = smaller?.blob ?? file;
    const mimeType = smaller?.mimeType ?? imageType;
    if (!mimeType) return 'unsupported';
    if (source.size > MAX_IMAGE_BYTES) return 'too-large';
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(source);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { name: file.name || 'obrazek.png', kind: 'image', mimeType, data: base64, preview: dataUrl };
  }
  if (file.size > MAX_TEXT_BYTES) return 'too-large';
  const text = await file.text();
  if (text.includes('\u0000')) return 'unsupported'; // binary — not inlinable
  return { name: file.name, kind: 'text', mimeType: file.type || 'text/plain', data: text };
}
