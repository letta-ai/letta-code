import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getChannelDir } from "@/channels/config";
import { isRecord } from "@/utils/type-guards";

export interface XChatPublicKeyRegistrationBody {
  public_key: {
    identity_public_key_signature: string;
    public_key: string;
    public_key_fingerprint: string;
    registration_method: string;
    signing_public_key: string;
    signing_public_key_signature: string;
  };
  version: string;
  generate_version: boolean;
}

export interface XChatRegistrationCheckpoint {
  schemaVersion: 1;
  userId: string;
  createdAt: string;
  privateKeysBase64: string;
  identityFingerprint: string;
  identityPublicKey: string;
  signingPublicKey: string;
  registrationBody: XChatPublicKeyRegistrationBody;
  registeredVersion?: string;
}

function checkpointId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 24);
}

function checkpointDir(): string {
  return join(getChannelDir("xchat"), "registration");
}

export function ensureXChatRegistrationStateDir(): string {
  const dir = checkpointDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function getXChatRegistrationCheckpointPath(userId: string): string {
  return join(checkpointDir(), `${checkpointId(userId)}.json`);
}

export function getXChatRegistrationLockPath(userId: string): string {
  return join(checkpointDir(), `${checkpointId(userId)}.lock`);
}

/** Remove private-key temp files left before an atomic checkpoint rename. */
export function cleanupXChatRegistrationTemporaryFiles(userId: string): void {
  const checkpointPath = getXChatRegistrationCheckpointPath(userId);
  const dir = dirname(checkpointPath);
  const prefix = `${basename(checkpointPath)}.`;
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    try {
      unlinkSync(join(dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
}

function requiredString(
  value: unknown,
  field: string,
  checkpointPath: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `X Chat registration checkpoint ${checkpointPath} has an invalid ${field}. ` +
        "Refusing to replace it because it may be the only copy of a private identity.",
    );
  }
  return value;
}

function parseRegistrationBody(
  value: unknown,
  checkpointPath: string,
): XChatPublicKeyRegistrationBody {
  if (!isRecord(value) || !isRecord(value.public_key)) {
    throw new Error(
      `X Chat registration checkpoint ${checkpointPath} has an invalid public registration payload. ` +
        "Refusing to replace it because it may be the only copy of a private identity.",
    );
  }
  const publicKey = value.public_key;
  if (typeof value.generate_version !== "boolean") {
    throw new Error(
      `X Chat registration checkpoint ${checkpointPath} has an invalid version-generation flag. ` +
        "Refusing to replace it because it may be the only copy of a private identity.",
    );
  }
  return {
    public_key: {
      identity_public_key_signature: requiredString(
        publicKey.identity_public_key_signature,
        "identity public-key signature",
        checkpointPath,
      ),
      public_key: requiredString(
        publicKey.public_key,
        "identity public key",
        checkpointPath,
      ),
      public_key_fingerprint: requiredString(
        publicKey.public_key_fingerprint,
        "public-key fingerprint",
        checkpointPath,
      ),
      registration_method: requiredString(
        publicKey.registration_method,
        "registration method",
        checkpointPath,
      ),
      signing_public_key: requiredString(
        publicKey.signing_public_key,
        "signing public key",
        checkpointPath,
      ),
      signing_public_key_signature: requiredString(
        publicKey.signing_public_key_signature,
        "signing public-key signature",
        checkpointPath,
      ),
    },
    version: requiredString(
      value.version,
      "generated key version",
      checkpointPath,
    ),
    generate_version: value.generate_version,
  };
}

function parseCheckpoint(
  value: unknown,
  expectedUserId: string,
  checkpointPath: string,
): XChatRegistrationCheckpoint {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(
      `X Chat registration checkpoint ${checkpointPath} has an unsupported format. ` +
        "Refusing to replace it because it may be the only copy of a private identity.",
    );
  }
  const userId = requiredString(value.userId, "bot user ID", checkpointPath);
  if (userId !== expectedUserId) {
    throw new Error(
      `X Chat registration checkpoint ${checkpointPath} belongs to a different bot user.`,
    );
  }
  const privateKeysBase64 = requiredString(
    value.privateKeysBase64,
    "private-key backup",
    checkpointPath,
  );
  let privateKeys: Buffer;
  try {
    privateKeys = Buffer.from(privateKeysBase64, "base64");
  } catch {
    privateKeys = Buffer.alloc(0);
  }
  if (
    privateKeys.length !== 64 ||
    privateKeysBase64.length !== 88 ||
    privateKeys.toString("base64") !== privateKeysBase64
  ) {
    privateKeys.fill(0);
    throw new Error(
      `X Chat registration checkpoint ${checkpointPath} has an invalid private-key backup. ` +
        "Refusing to replace it because it may be the only copy of a private identity.",
    );
  }
  privateKeys.fill(0);

  return {
    schemaVersion: 1,
    userId,
    createdAt: requiredString(value.createdAt, "creation time", checkpointPath),
    privateKeysBase64,
    identityFingerprint: requiredString(
      value.identityFingerprint,
      "identity fingerprint",
      checkpointPath,
    ),
    identityPublicKey: requiredString(
      value.identityPublicKey,
      "raw identity public key",
      checkpointPath,
    ),
    signingPublicKey: requiredString(
      value.signingPublicKey,
      "raw signing public key",
      checkpointPath,
    ),
    registrationBody: parseRegistrationBody(
      value.registrationBody,
      checkpointPath,
    ),
    ...(typeof value.registeredVersion === "string" &&
    value.registeredVersion.length > 0
      ? { registeredVersion: value.registeredVersion }
      : {}),
  };
}

export function readXChatRegistrationCheckpoint(
  userId: string,
): XChatRegistrationCheckpoint | null {
  const checkpointPath = getXChatRegistrationCheckpointPath(userId);
  if (!existsSync(checkpointPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch (error) {
    throw new Error(
      `X Chat registration checkpoint ${checkpointPath} is unreadable. ` +
        "Refusing to replace it because it may be the only copy of a private identity.",
      { cause: error },
    );
  }
  chmodSync(checkpointPath, 0o600);
  return parseCheckpoint(parsed, userId, checkpointPath);
}

export function writeXChatRegistrationCheckpoint(
  checkpoint: XChatRegistrationCheckpoint,
): void {
  ensureXChatRegistrationStateDir();
  const checkpointPath = getXChatRegistrationCheckpointPath(checkpoint.userId);
  const tempPath = `${checkpointPath}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(tempPath, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify(checkpoint, null, 2)}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(tempPath, checkpointPath);
    chmodSync(checkpointPath, 0o600);
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The failed write path may already have closed it.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // A successful rename removes the temporary path.
    }
  }
}

export function deleteXChatRegistrationCheckpoint(userId: string): void {
  try {
    unlinkSync(getXChatRegistrationCheckpointPath(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}
