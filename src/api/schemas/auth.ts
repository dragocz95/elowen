import { z } from 'zod';

/** Login credentials. Empty strings pass the shape check on purpose — an empty/wrong credential is an
 *  auth failure (401 from `users.verify`), not a malformed request (400). */
export const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

/** Self-service profile patch. All fields optional; the allowed-exec business rule stays in the handler. */
export const profilePatchSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  default_exec: z.string().optional(),
});

/** Password change. The 8-char floor is enforced here, folding the old separate length check into the
 *  shape validation (both surfaced as a 400 before). */
export const passwordChangeSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8, 'new password too short (min 8)'),
});

/** Admin edit of another user's role + model allow-list. Both optional; the handler applies each only
 *  when present and enforces the last-admin / global-allow-list rules. */
export const userPermissionsSchema = z.object({
  is_admin: z.boolean().optional(),
  allowed_execs: z.array(z.string()).optional(),
});

/** Assign a project to a user. */
export const projectAssignSchema = z.object({
  projectId: z.number(),
});

/** Save a user's prompt override. The content must be non-empty (after trim) — an empty override would
 *  spawn agents with a blank prompt; to revert to the default the client deletes the override instead.
 *  A generous ceiling guards the DB row without constraining real prompts. */
export const promptSaveSchema = z.object({
  content: z.string().trim().min(1, 'prompt cannot be empty').max(100_000, 'prompt too long'),
});
