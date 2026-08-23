/** A file the user attached to a conversation.
 *
 *  An attachment used to have to FIT IN THE MESSAGE: an image was downscaled and base64-encoded into the
 *  request, a text file was inlined into the prompt between fences, and anything else was refused. That
 *  is where the four-type allow-list, the 5 MB image ceiling, the 256 kB text ceiling and the "binary —
 *  not inlinable" rejection all came from. None of them described a real limitation; they described the
 *  cost of carrying bytes inside a chat message.
 *
 *  The file is now uploaded into the user's project first, and the message carries its PATH. So there is
 *  nothing to encode, nothing to downscale and no type to admit or refuse — and the agent reads it with
 *  the file tools it already has, which sniff the type from the content, inline images as vision blocks
 *  and even render PDF pages. One read path instead of two.
 */
export interface Attachment {
  /** Name as stored, which may differ from the file's own name when it collided or was sanitized. */
  name: string;
  /** Absolute path on the daemon host — what the message hands the agent. */
  path: string;
  /** Path within the project, for display. */
  relative: string;
  size: number;
}

/** Why an attachment did not make it. One value: there is no longer any such thing as an unsupported
 *  type or a file that is too big, so a failure here is the transfer itself. */
export type AttachRefusal = 'failed';

/**
 * Upload one file and return the reference to attach.
 *
 * The body is the file itself rather than multipart form data: the browser streams a `File` body, the
 * BFF proxy streams it through and the daemon pipes it to disk, so nothing on the path holds the whole
 * thing in memory. Wrapping it in multipart would make every hop materialize it instead.
 */
export async function uploadAttachment(file: File): Promise<Attachment | AttachRefusal> {
  try {
    const res = await fetch(`/api/brain/uploads?name=${encodeURIComponent(file.name || 'upload')}`, {
      method: 'POST',
      // The session cookie is same-origin and the BFF turns it into the daemon bearer, so no token here.
      body: file,
      headers: { 'content-type': file.type || 'application/octet-stream' },
    });
    if (!res.ok) return 'failed';
    const body = await res.json() as Partial<Attachment>;
    if (typeof body.path !== 'string' || typeof body.name !== 'string') return 'failed';
    return {
      name: body.name,
      path: body.path,
      relative: typeof body.relative === 'string' ? body.relative : body.name,
      size: typeof body.size === 'number' ? body.size : 0,
    };
  } catch {
    return 'failed';
  }
}
