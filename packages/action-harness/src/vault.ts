import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";

export type EncryptedVaultRecord = {
  version: "workspace-vault.v1";
  handle: string;
  kind: "credential" | "auth_session" | "identity" | "address" | "payment";
  origin: string;
  key_version: string;
  salt: string;
  iv: string;
  auth_tag: string;
  ciphertext: string;
  created_at: string;
};

export interface EncryptedVaultStore {
  put(record: EncryptedVaultRecord): Promise<void>;
  get(handle: string): Promise<EncryptedVaultRecord | null>;
}

export class InMemoryEncryptedVaultStore implements EncryptedVaultStore {
  readonly #records = new Map<string, EncryptedVaultRecord>();

  async put(record: EncryptedVaultRecord) {
    if (this.#records.has(record.handle)) throw new Error("vault handle already exists");
    this.#records.set(record.handle, structuredClone(record));
  }

  async get(handle: string) {
    const record = this.#records.get(handle);
    return record ? structuredClone(record) : null;
  }
}

function exactHttpsOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("vault origin must be one exact HTTPS origin");
  }
  return url.origin;
}

function aad(
  workspaceId: string,
  record: Pick<EncryptedVaultRecord, "version" | "handle" | "kind" | "origin" | "key_version">,
) {
  return Buffer.from(
    JSON.stringify({
      version: record.version,
      workspace_id: workspaceId,
      handle: record.handle,
      kind: record.kind,
      origin: record.origin,
      key_version: record.key_version,
    }),
    "utf8",
  );
}

function derivedKey(masterKey: Buffer, workspaceId: string, salt: Buffer, keyVersion: string) {
  if (!workspaceId.trim() || workspaceId.length > 240) throw new Error("invalid workspace scope");
  return Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      salt,
      Buffer.from(`co/action-vault/${keyVersion}/${workspaceId}`, "utf8"),
      32,
    ),
  );
}

export class WorkspaceBoundVault {
  readonly #masterKey: Buffer;

  constructor(
    masterKey: Uint8Array,
    private readonly store: EncryptedVaultStore,
    private readonly keyVersion = "v1",
  ) {
    if (masterKey.byteLength !== 32)
      throw new Error("vault master key must contain exactly 32 random bytes");
    this.#masterKey = Buffer.from(masterKey);
  }

  async seal(input: {
    workspaceId: string;
    kind: EncryptedVaultRecord["kind"];
    origin: string;
    secret: Uint8Array;
    now?: Date;
  }) {
    if (input.secret.byteLength === 0 || input.secret.byteLength > 64_000)
      throw new Error("invalid vault secret length");
    const origin = exactHttpsOrigin(input.origin);
    const handle = randomUUID();
    const salt = randomBytes(32);
    const iv = randomBytes(12);
    const key = derivedKey(this.#masterKey, input.workspaceId, salt, this.keyVersion);
    const recordBase = {
      version: "workspace-vault.v1" as const,
      handle,
      kind: input.kind,
      origin,
      key_version: this.keyVersion,
    };
    const plaintext = Buffer.from(input.secret);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      cipher.setAAD(aad(input.workspaceId, recordBase));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const record: EncryptedVaultRecord = {
        ...recordBase,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        auth_tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        created_at: (input.now ?? new Date()).toISOString(),
      };
      await this.store.put(record);
      return { handle, kind: record.kind, origin: record.origin };
    } finally {
      plaintext.fill(0);
      key.fill(0);
      salt.fill(0);
      iv.fill(0);
    }
  }

  async metadata(handle: string) {
    const record = await this.store.get(handle);
    return record ? { handle: record.handle, kind: record.kind, origin: record.origin } : null;
  }

  async withSecret<T>(
    input: {
      workspaceId: string;
      handle: string;
      currentOrigin: string;
    },
    use: (
      secret: Uint8Array,
      metadata: { kind: EncryptedVaultRecord["kind"]; origin: string },
    ) => Promise<T>,
  ) {
    const record = await this.store.get(input.handle);
    if (!record || exactHttpsOrigin(input.currentOrigin) !== record.origin) {
      throw new Error("vault reference unavailable for this origin");
    }
    const salt = Buffer.from(record.salt, "base64");
    const iv = Buffer.from(record.iv, "base64");
    const tag = Buffer.from(record.auth_tag, "base64");
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    const key = derivedKey(this.#masterKey, input.workspaceId, salt, record.key_version);
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      decipher.setAAD(aad(input.workspaceId, record));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      key.fill(0);
      salt.fill(0);
      iv.fill(0);
      tag.fill(0);
      ciphertext.fill(0);
      throw new Error("vault reference unavailable for this workspace");
    }
    try {
      return await use(plaintext, { kind: record.kind, origin: record.origin });
    } finally {
      plaintext.fill(0);
      key.fill(0);
      salt.fill(0);
      iv.fill(0);
      tag.fill(0);
      ciphertext.fill(0);
    }
  }

  destroy() {
    this.#masterKey.fill(0);
  }
}
