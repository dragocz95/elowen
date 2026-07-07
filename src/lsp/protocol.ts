/** Language Server Protocol wire codec. LSP frames JSON-RPC messages with a `Content-Length` header
 *  (`Content-Length: N\r\n\r\n<json>`), exactly like HTTP. This module is the pure, transport-agnostic
 *  heart of the client: it encodes a message to bytes and incrementally decodes a byte stream into whole
 *  messages — so it is fully unit-testable without ever spawning a real language server. */

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Serialize a JSON-RPC message to a framed LSP payload (header + body). */
export function encodeMessage(msg: JsonRpcMessage): string {
  const body = JSON.stringify(msg);
  // Content-Length counts BYTES, not characters — multibyte content (a diagnostic with an emoji) would
  // otherwise under-count and desync the peer's parser.
  const length = Buffer.byteLength(body, 'utf8');
  return `Content-Length: ${length}\r\n\r\n${body}`;
}

/** Incremental LSP frame decoder. Feed it raw chunks; it yields every complete message it can parse and
 *  keeps the partial remainder buffered until the rest arrives. Robust to headers and bodies split across
 *  chunk boundaries (the normal case over a pipe), and skips a malformed frame rather than wedging. */
export class MessageDecoder {
  private buffer = Buffer.alloc(0);

  /** Append a chunk and return every whole message now available (possibly none). */
  push(chunk: Buffer | string): JsonRpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
    const out: JsonRpcMessage[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break; // headers not fully arrived yet
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unparseable header block — drop it and resync past this separator rather than looping forever.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) break; // body not fully arrived yet
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      try { out.push(JSON.parse(body) as JsonRpcMessage); }
      catch { /* a corrupt frame is skipped; the stream stays aligned via the byte-accurate length */ }
    }
    return out;
  }
}
