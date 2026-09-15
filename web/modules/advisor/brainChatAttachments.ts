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
  /** The absolute path the message hands the agent, IN THE PROJECT'S OWN FILESYSTEM: a daemon host path
   *  for a host project, and an absolute GUEST path for a managed one. The same `Read` opens either,
   *  because the turn runs in the project the file was uploaded into — which is exactly why the upload
   *  resolves its target from the conversation instead of from the client. */
  path: string;
  /** Path within the project, for display. */
  relative: string;
  size: number;
}

/** Why an attachment did not make it. There is no longer any such thing as an unsupported type or a file
 *  that is too big, so a failure here is either the transfer itself or a placement refusal — and those
 *  two need different words. A refusal like "ask an administrator to assign you one" is the only thing
 *  that tells the user what to DO, and collapsing it into a generic "upload failed" is what turns a
 *  one-line configuration fix into a day of guessing. */
export interface AttachRefusal {
  failed: true;
  /** The server's own explanation, when it sent a usable one. */
  reason?: string;
}

/** Longest server message worth putting in a toast. The route's refusals name every candidate project,
 *  so the text is bounded but not short; anything past this is not a sentence a user can act on. */
const MAX_REASON_CHARS = 300;

/** The error text from a refused upload, or nothing when the response carries no usable message. */
async function refusalReason(res: Response): Promise<string | undefined> {
  try {
    const body = await res.json() as { error?: unknown };
    if (typeof body.error !== 'string') return undefined;
    const text = body.error.trim();
    return text ? text.slice(0, MAX_REASON_CHARS) : undefined;
  } catch { return undefined; }
}

/**
 * Upload one file and return the reference to attach.
 *
 * The body is the file itself rather than multipart form data: the browser streams a `File` body, the
 * BFF proxy streams it through and the daemon pipes it to disk, so nothing on the path holds the whole
 * thing in memory. Wrapping it in multipart would make every hop materialize it instead.
 *
 * `session` is the OPAQUE conversation id and nothing else: the server decides from it which project the
 * file belongs in, after checking the conversation is this account's. The client never names a project,
 * and never a path. `size` is the file's declared length, which the managed transport needs to open its
 * upload handle before the first byte arrives; the server still proves the stored size on commit.
 */
export async function uploadAttachment(file: File, sessionId: string | undefined): Promise<Attachment | AttachRefusal> {
  try {
    const query = new URLSearchParams({ name: file.name || 'upload', size: String(file.size) });
    if (sessionId) query.set('session', sessionId);
    const res = await fetch(`/api/brain/uploads?${query.toString()}`, {
      method: 'POST',
      // The session cookie is same-origin and the BFF turns it into the daemon bearer, so no token here.
      body: file,
      headers: { 'content-type': file.type || 'application/octet-stream' },
    });
    if (!res.ok) return { failed: true, reason: await refusalReason(res) };
    const body = await res.json() as Partial<Attachment>;
    if (typeof body.path !== 'string' || typeof body.name !== 'string') return { failed: true };
    return {
      name: body.name,
      path: body.path,
      relative: typeof body.relative === 'string' ? body.relative : body.name,
      size: typeof body.size === 'number' ? body.size : 0,
    };
  } catch {
    return { failed: true };
  }
}
