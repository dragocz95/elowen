import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { assertPathAllowed, isAllAccess } from '../../plugins/pathGuard.js';
import { currentSessionId, currentTurnToken, currentIdentity } from '../../plugins/policyContext.js';
import { chatFilesDir, storeFileByContent, type StoredChatFile } from '../chatFiles.js';
import {
  isManagedProjectTurn,
  readManagedGuestArtifact,
  type SandboxResolver,
} from '../managedArtifacts.js';

/** Large enough for normal documents, archives, and generated artifacts while staying below common chat
 *  upload ceilings and bounding the synchronous read + in-memory copy this local handoff necessarily makes. */
const MAX_BYTES = 25 * 1024 * 1024;

/** Matches ShareImage: one model turn may hand over a small set of deliberate artifacts, not dump a tree. */
const MAX_PER_TURN = 4;

export interface ShareFileDeps {
  /** The existing attachment root; general files are stored in its sibling `chat-files` directory. */
  imagesDir?: string;
  /** Live Sandbox provider for managed-project turns: resolved fresh per call (`control('sandbox')`), so
   *  a plugin reload never leaves the tool holding a stale control. Absent ⇒ a managed turn refuses —
   *  there is no host fallback for a guest path — while host-project turns are unaffected. Wired by the
   *  session spawner at composition time. */
  sandbox?: SandboxResolver;
}

function text(message: string) {
  return { content: [{ type: 'text' as const, text: message }], details: {} };
}

/** Let the agent hand a durable artifact to the web-chat user. Unlike ShareImage, the browser always treats
 *  these bytes as a download and never renders them from the application's origin. */
export function buildShareFileTool(deps: ShareFileDeps) {
  const spent = new WeakMap<object, number>();
  return defineTool({
    name: 'ShareFile',
    label: 'Share file',
    description: 'Give the user a file to download from the web conversation — a document, archive, generated report, HTML file, source bundle, or another artifact they should KEEP. Use ShareImage instead when an image is something the user should SEE directly in the conversation; use ShareFile when the deliverable should be saved to their device. Pass an absolute `path` and optionally one short `caption`. Inside a managed project the path is an absolute path in the project environment; otherwise it must stay inside the caller’s accessible repositories — and on an unrestricted (all-access) session, sharing by path additionally requires an account that administers this instance. The file must be at most 25 MB. At most 4 files may be shared per turn. The bytes are copied into conversation storage and served only as an authenticated download; the original filename is preserved. This affordance is implemented by the web chat (including a sub-agent’s own panel); on another chat platform use its platform-specific file-upload tool instead.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path to the file the user should download.' }),
      caption: Type.Optional(Type.String({ description: 'One short line explaining what the file is.' })),
    }),
    execute: async (_id: string, p: { path: string; caption?: string }) => {
      if (!deps.imagesDir) return text('ShareFile: this session has nowhere to store files, so it cannot share them.');
      const sessionId = currentSessionId();
      const turn = currentTurnToken();
      if (!sessionId || !turn) return text('ShareFile: no conversation to share into.');
      const used = spent.get(turn) ?? 0;
      if (used >= MAX_PER_TURN) return text(`ShareFile: already shared ${MAX_PER_TURN} files in this turn — describe or bundle the rest instead.`);

      const stored = await managed(p.path, deps) ?? fromDisk(p.path, chatFilesDir(deps.imagesDir));
      if (typeof stored === 'string') return text(stored);
      spent.set(turn, used + 1);
      const caption = p.caption?.trim();
      return {
        content: [{ type: 'text' as const, text: `Shared ${stored.name} with the user as a download${caption ? ` (${caption})` : ''}. Do not replace it with a file:// link.` }],
        details: { sharedFile: { ...stored, ...(caption ? { caption } : {}) } },
      };
    },
  });

  /** The managed-project branch: the path is a GUEST path, the bytes come from the Sandbox projectFiles
   *  provider (bounded, version-checked), and none of the host fs machinery in `fromDisk` is touched.
   *  Returns null only for a NON-managed turn, so the legacy host branch answers that one; inside a
   *  managed turn every outcome is a managed answer. The two never mix: in a managed turn
   *  `assertPathAllowed` refuses every host path, and a guest path has no host existence at all.
   *
   *  Authorization is the PROVIDER's (per-operation account/project check); the managed guest is a whole
   *  filesystem the model may share from anywhere in, so confinement is not the boundary here — the path
   *  is only checked for shape. A relative path is refused as an invalid absolute guest path and an
   *  unreachable provider is a refusal, never a host read. */
  async function managed(rawPath: string, toolDeps: ShareFileDeps): Promise<StoredChatFile | string | null> {
    // The ambient execution target decides the BRANCH — explicitly, never by matching a refusal string.
    // Only a NON-managed turn answers from the host branch; the shared guest read below validates the
    // context (legacy workspace scope, missing linked account, session) and then the path, and every
    // failure is a managed refusal — the host path guard is never consulted, whatever the input looks like.
    if (!isManagedProjectTurn()) return null;
    const artifact = await readManagedGuestArtifact(toolDeps.sandbox, rawPath, MAX_BYTES);
    if (typeof artifact === 'string') return `ShareFile: ${artifact}`;
    const name = basename(artifact.path);
    const stored = storeFileByContent(chatFilesDir(toolDeps.imagesDir!), artifact.bytes, name);
    return stored ?? `ShareFile: could not store ${name}.`;
  }
}

function fromDisk(rawPath: string, dir: string): StoredChatFile | string {
  // All-access skips path roots entirely (pathGuard), so for such a turn THIS is the only boundary on
  // which host file may be published into a conversation.
  //
  // It was briefly removed on the argument that an all-access caller can already obtain the same bytes
  // with Read, making this gate a difference without a distinction. That argument is FALSE, and the
  // counter-example is a shape we create routinely: a delegated child. A role's `allow`-list narrows only
  // PLUGIN tools — built-ins stay composed (capabilities.ts:322-330) — so a sub-agent delegated with
  // `tools: ['Grep']` has no Read at all, yet still holds ShareFile. Give that child an admin scope and
  // it can publish any file on the host, including the config DB, having been handed a deliberately
  // narrow toolset. Durable `delegated_access` rows with `admin: true, owner: false` predate the isOwner
  // widening and remain resumable, so the combination is reachable, not hypothetical.
  //
  // A scoped (non-all-access) caller is unaffected: their roots already contain them.
  if (isAllAccess() && currentIdentity()?.owner !== true) {
    return 'ShareFile: sharing a file by path is not available to you. Ask an administrator to share it.';
  }
  let path: string;
  try { path = assertPathAllowed(rawPath); }
  catch (e) { return `ShareFile: ${(e as Error).message}`; }

  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return `ShareFile: ${basename(path)} is not a file.`;
    size = stat.size;
  } catch { return `ShareFile: cannot find ${basename(path)}.`; }
  // Checked BEFORE readFileSync so an oversized artifact is refused without first allocating it in memory.
  if (size > MAX_BYTES) return `ShareFile: ${basename(path)} is ${(size / 1048576).toFixed(1)} MB, over the ${MAX_BYTES / 1048576} MB limit.`;

  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch { return `ShareFile: cannot read ${basename(path)}.`; }
  const stored = storeFileByContent(dir, bytes, basename(path));
  return stored ?? `ShareFile: could not store ${basename(path)}.`;
}
