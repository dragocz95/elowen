import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Db } from './db.js';
import type { PluginSecretBag, PluginSecretValue } from '../shared/pluginSecrets.js';

const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const MAX_SECRET_BYTES = 1024 * 1024;
const CANARY_PREFIX = 'elowen-plugin-secret-vault';

type SecretScope = 'instance' | 'user';

interface SecretOwner {
  scope: SecretScope;
  ownerId: number | null;
  plugin: string;
}

interface SecretRow extends SecretOwner {
  key: string;
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  format_version: number;
  cas_version: number;
}

interface MetadataRow {
  format_version: number;
  key_fingerprint: string;
  canary_ciphertext: Buffer;
  canary_nonce: Buffer;
  canary_auth_tag: Buffer;
}

export interface PluginSecretVaultReadiness {
  ready: boolean;
  error?: string;
  corrupt: { scope: SecretScope; ownerId: number | null; plugin: string; key: string }[];
}

export class PluginSecretVaultUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSecretVaultUnavailableError';
  }
}

export class PluginSecretCorruptError extends Error {
  constructor(scope: SecretScope, ownerId: number | null, plugin: string, key: string) {
    super(`encrypted plugin secret is corrupt (${scope}:${ownerId ?? 'instance'}:${plugin}:${key}); reconnect required`);
    this.name = 'PluginSecretCorruptError';
  }
}

export class PluginSecretVersionError extends Error {
  constructor(expected: number, actual: number) {
    super(`plugin secret version conflict: expected ${expected}, found ${actual}`);
    this.name = 'PluginSecretVersionError';
  }
}

export interface PluginSecretVaultOptions {
  keyPath?: string;
  allowKeyInitialization: boolean;
  /** Tests and in-memory cores may supply process-local key material without touching the host filesystem. */
  key?: Buffer;
}

export class PluginSecretVault {
  private key: Buffer | null = null;
  private unavailableReason: string | null = null;
  private readonly corruptRows = new Map<string, SecretRow>();

  constructor(private readonly db: Db, private readonly options: PluginSecretVaultOptions) {
    this.initialize();
  }

  readiness(): PluginSecretVaultReadiness {
    return {
      ready: this.unavailableReason === null,
      ...(this.unavailableReason ? { error: this.unavailableReason } : {}),
      corrupt: [...this.corruptRows.values()].map((row) => ({
        scope: row.scope,
        ownerId: row.ownerId,
        plugin: row.plugin,
        key: row.key,
      })),
    };
  }

  instance(plugin: string): PluginSecretBag {
    return this.bag({ scope: 'instance', ownerId: null, plugin: validatePlugin(plugin) });
  }

  user(userId: number, plugin: string): PluginSecretBag {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new TypeError('invalid plugin secret user id');
    return this.bag({ scope: 'user', ownerId: userId, plugin: validatePlugin(plugin) });
  }

  deleteUser(userId: number): number {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new TypeError('invalid plugin secret user id');
    const info = this.db.prepare("DELETE FROM plugin_secrets WHERE scope = 'user' AND owner_id = ?").run(userId);
    for (const [id, row] of this.corruptRows) {
      if (row.scope === 'user' && row.ownerId === userId) this.corruptRows.delete(id);
    }
    return info.changes;
  }

  private bag(owner: SecretOwner): PluginSecretBag {
    return {
      get: (key) => this.get(owner, validateKey(key)),
      has: (key) => this.get(owner, validateKey(key)) !== null,
      set: (key, value, expectedVersion) => this.set(owner, validateKey(key), value, expectedVersion),
      delete: (key) => this.remove(owner, validateKey(key)),
    };
  }

  private initialize(): void {
    const encryptedRows = (this.db.prepare('SELECT COUNT(*) AS count FROM plugin_secrets').get() as { count: number }).count;
    let key = this.options.key ? validateRawKey(this.options.key) : this.readKeyFile();

    if (!key && encryptedRows > 0) {
      this.unavailableReason = 'plugin secret vault key is missing or malformed while encrypted rows exist';
      return;
    }
    if (!key) {
      if (!this.options.allowKeyInitialization) {
        this.unavailableReason = 'plugin secret vault key is unavailable in this process';
        return;
      }
      key = randomBytes(KEY_BYTES);
      if (this.options.keyPath) this.replaceKeyFile(key);
    }
    this.key = key;

    const metadata = this.db.prepare('SELECT * FROM plugin_secret_vault_metadata WHERE id = 1').get() as MetadataRow | undefined;
    if (!metadata) {
      if (encryptedRows > 0) {
        this.unavailableReason = 'plugin secret vault canary is missing while encrypted rows exist';
        return;
      }
      if (!this.options.allowKeyInitialization) {
        this.unavailableReason = 'plugin secret vault canary is unavailable in this process';
        return;
      }
      this.writeCanary(key);
    } else if (!this.verifyCanary(key, metadata)) {
      if (encryptedRows > 0 || !this.options.allowKeyInitialization) {
        this.unavailableReason = 'plugin secret vault key does not match its authenticated canary';
        return;
      }
      const replacement = randomBytes(KEY_BYTES);
      this.key = replacement;
      if (this.options.keyPath) this.replaceKeyFile(replacement);
      this.writeCanary(replacement);
    }

    for (const row of this.db.prepare('SELECT scope, owner_id AS ownerId, plugin, key, ciphertext, nonce, auth_tag, format_version, cas_version FROM plugin_secrets').all() as SecretRow[]) {
      try { this.decrypt(row); }
      catch { this.corruptRows.set(rowId(row), row); }
    }
  }

  private readKeyFile(): Buffer | null {
    const path = this.options.keyPath;
    if (!path || !existsSync(path)) return null;
    try {
      const key = validateRawKey(readFileSync(path));
      if (key && this.options.allowKeyInitialization) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        chmodSync(dirname(path), 0o700);
        chmodSync(path, 0o600);
      }
      return key;
    } catch {
      return null;
    }
  }

  private replaceKeyFile(key: Buffer): void {
    const path = this.options.keyPath;
    if (!path) return;
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, key, { mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
      chmodSync(path, 0o600);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }

  private writeCanary(key: Buffer): void {
    const fingerprint = fingerprintOf(key);
    const encrypted = encrypt(key, `${CANARY_PREFIX}:${fingerprint}`, canaryAad(fingerprint));
    this.db.prepare(`INSERT INTO plugin_secret_vault_metadata
      (id, format_version, key_fingerprint, canary_ciphertext, canary_nonce, canary_auth_tag, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        format_version = excluded.format_version,
        key_fingerprint = excluded.key_fingerprint,
        canary_ciphertext = excluded.canary_ciphertext,
        canary_nonce = excluded.canary_nonce,
        canary_auth_tag = excluded.canary_auth_tag,
        updated_at = datetime('now')`)
      .run(FORMAT_VERSION, fingerprint, encrypted.ciphertext, encrypted.nonce, encrypted.authTag);
  }

  private verifyCanary(key: Buffer, metadata: MetadataRow): boolean {
    if (metadata.format_version !== FORMAT_VERSION) return false;
    const fingerprint = fingerprintOf(key);
    if (metadata.key_fingerprint !== fingerprint) return false;
    try {
      const value = decrypt(key, metadata.canary_ciphertext, metadata.canary_nonce, metadata.canary_auth_tag, canaryAad(fingerprint));
      return value === `${CANARY_PREFIX}:${fingerprint}`;
    } catch {
      return false;
    }
  }

  private requireKey(): Buffer {
    if (this.unavailableReason || !this.key) {
      throw new PluginSecretVaultUnavailableError(this.unavailableReason ?? 'plugin secret vault is unavailable');
    }
    return this.key;
  }

  private get(owner: SecretOwner, keyName: string): PluginSecretValue | null {
    const key = this.requireKey();
    const row = this.select(owner, keyName);
    if (!row) return null;
    if (this.corruptRows.has(rowId(row))) throw new PluginSecretCorruptError(row.scope, row.ownerId, row.plugin, row.key);
    try {
      return { value: this.decrypt(row, key), version: row.cas_version };
    } catch {
      this.corruptRows.set(rowId(row), row);
      throw new PluginSecretCorruptError(row.scope, row.ownerId, row.plugin, row.key);
    }
  }

  private set(owner: SecretOwner, keyName: string, value: string, expectedVersion?: number): number {
    const key = this.requireKey();
    if (typeof value !== 'string') throw new TypeError('plugin secret value must be a string');
    if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) throw new RangeError('plugin secret exceeds 1 MiB');
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
      throw new TypeError('expected plugin secret version must be a non-negative integer');
    }

    return this.db.transaction(() => {
      const current = this.select(owner, keyName);
      const actualVersion = current?.cas_version ?? 0;
      if (expectedVersion !== undefined && expectedVersion !== actualVersion) {
        throw new PluginSecretVersionError(expectedVersion, actualVersion);
      }
      const nextVersion = actualVersion + 1;
      const encrypted = encrypt(key, value, secretAad(owner, keyName));
      if (current) {
        this.db.prepare(`UPDATE plugin_secrets SET
          ciphertext = ?, nonce = ?, auth_tag = ?, format_version = ?, cas_version = ?, updated_at = datetime('now')
          WHERE scope = ? AND owner_id IS ? AND plugin = ? AND key = ?`)
          .run(encrypted.ciphertext, encrypted.nonce, encrypted.authTag, FORMAT_VERSION, nextVersion,
            owner.scope, owner.ownerId, owner.plugin, keyName);
      } else {
        this.db.prepare(`INSERT INTO plugin_secrets
          (scope, owner_id, plugin, key, ciphertext, nonce, auth_tag, format_version, cas_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(owner.scope, owner.ownerId, owner.plugin, keyName, encrypted.ciphertext, encrypted.nonce,
            encrypted.authTag, FORMAT_VERSION, nextVersion);
      }
      this.corruptRows.delete(rowId({ ...owner, key: keyName }));
      return nextVersion;
    }).immediate();
  }

  private remove(owner: SecretOwner, keyName: string): boolean {
    this.requireKey();
    const info = this.db.prepare('DELETE FROM plugin_secrets WHERE scope = ? AND owner_id IS ? AND plugin = ? AND key = ?')
      .run(owner.scope, owner.ownerId, owner.plugin, keyName);
    this.corruptRows.delete(rowId({ ...owner, key: keyName }));
    return info.changes > 0;
  }

  private select(owner: SecretOwner, keyName: string): SecretRow | undefined {
    return this.db.prepare(`SELECT scope, owner_id AS ownerId, plugin, key, ciphertext, nonce, auth_tag, format_version, cas_version
      FROM plugin_secrets WHERE scope = ? AND owner_id IS ? AND plugin = ? AND key = ?`)
      .get(owner.scope, owner.ownerId, owner.plugin, keyName) as SecretRow | undefined;
  }

  private decrypt(row: SecretRow, key = this.requireKey()): string {
    if (row.format_version !== FORMAT_VERSION || row.nonce.length !== NONCE_BYTES || row.auth_tag.length !== 16) {
      throw new Error('unsupported encrypted plugin secret format');
    }
    return decrypt(key, row.ciphertext, row.nonce, row.auth_tag, secretAad(row, row.key));
  }
}

function encrypt(key: Buffer, value: string, aad: Buffer): { ciphertext: Buffer; nonce: Buffer; authTag: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, ciphertext: Buffer, nonce: Buffer, authTag: Buffer, aad: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function secretAad(owner: SecretOwner, key: string): Buffer {
  return Buffer.from([
    `format=${FORMAT_VERSION}`,
    `scope=${owner.scope}`,
    `owner=${owner.ownerId ?? 'instance'}`,
    `plugin=${owner.plugin}`,
    `key=${key}`,
  ].join('\n'), 'utf8');
}

function canaryAad(fingerprint: string): Buffer {
  return Buffer.from(`format=${FORMAT_VERSION}\nmetadata=canary\nfingerprint=${fingerprint}`, 'utf8');
}

function fingerprintOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}

function validateRawKey(value: Buffer): Buffer | null {
  return value.length === KEY_BYTES ? Buffer.from(value) : null;
}

function validatePlugin(plugin: string): string {
  const clean = plugin.trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(clean)) throw new TypeError('invalid plugin secret plugin name');
  return clean;
}

function validateKey(key: string): string {
  const clean = key.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(clean)) throw new TypeError('invalid plugin secret key');
  return clean;
}

function rowId(row: Pick<SecretRow, 'scope' | 'ownerId' | 'plugin' | 'key'>): string {
  return `${row.scope}\0${row.ownerId ?? ''}\0${row.plugin}\0${row.key}`;
}
