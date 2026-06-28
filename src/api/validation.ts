import { ZodError, type ZodType } from 'zod';
import type { Context } from 'hono';

/** Parse and validate a JSON request body against a zod schema. A malformed/empty body is treated as
 *  `undefined` (so a schema with required fields rejects it the same way a wrong shape does), and a
 *  validation failure throws the {@link ZodError} — the app's `onError` turns it into a clean 400 with
 *  the offending fields. Single source of truth for request-body shape across the route families:
 *  handlers declare a schema and read typed fields, instead of hand-rolling `typeof` ladders. */
export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { raw = undefined; }
  return schema.parse(raw);
}

/** Flatten a {@link ZodError} into a short, human-readable `path: message; …` string for the 400 body. */
export function formatZodError(err: ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}
