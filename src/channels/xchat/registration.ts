import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "@/utils/file-lock";
import { sleep } from "@/utils/sleep";
import { isRecord } from "@/utils/type-guards";
import {
  cleanupXChatRegistrationTemporaryFiles,
  deleteXChatRegistrationCheckpoint,
  ensureXChatRegistrationStateDir,
  getXChatRegistrationLockPath,
  readXChatRegistrationCheckpoint,
  writeXChatRegistrationCheckpoint,
  type XChatPublicKeyRegistrationBody,
  type XChatRegistrationCheckpoint,
} from "./registration-state";
import {
  loadXChatCryptoSdkModule,
  loadXChatJuiceboxSdkModule,
  loadXChatRawCryptoModule,
  loadXChatXdkModule,
  type XChatApiClientLike,
  type XChatJuiceboxChatLike,
  type XChatJuiceboxClientLike,
  type XChatJuiceboxConfigurationLike,
  type XChatRawCryptoLike,
  type XChatRegistrationPayloadLike,
} from "./runtime";

const PUBLIC_KEY_FIELDS = [
  "public_key",
  "signing_public_key",
  "identity_public_key_signature",
  "public_key_version",
  "juicebox_config",
];
const REGISTRATION_RECONCILIATION_DELAYS_MS = [0, 250, 1_000, 2_000, 4_000];
const JUICEBOX_RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000];

type StatusWriter = (message: string) => void;
type Waiter = (milliseconds: number) => Promise<void>;

export interface ProvisionXChatIdentityOptions {
  fetch?: typeof fetch;
  status?: StatusWriter;
  wait?: Waiter;
}

export interface ProvisionedXChatIdentity {
  userId: string;
  username?: string;
  signingKeyVersion: string;
  resumed: boolean;
}

export class XChatRegistrationRateLimitedError extends Error {
  readonly resetAt: Date | null;

  constructor(resetAt: Date | null) {
    const suffix = resetAt
      ? ` until ${resetAt.toLocaleString()}`
      : " for the current 24-hour window";
    super(
      `X Chat public-key registration is rate limited${suffix}. ` +
        "The private identity is saved locally; rerun the same configure command after the reset to resume it.",
    );
    this.name = "XChatRegistrationRateLimitedError";
    this.resetAt = resetAt;
  }
}

function recordString(
  record: Record<string, unknown>,
  camelCase: string,
  snakeCase: string,
): string {
  const value = record[camelCase] ?? record[snakeCase];
  return typeof value === "string" ? value.trim() : "";
}

function publicKeyVersion(record: Record<string, unknown>): string {
  return recordString(record, "publicKeyVersion", "public_key_version");
}

function publicKeyValue(record: Record<string, unknown>): string {
  return recordString(record, "publicKey", "public_key");
}

function signingPublicKeyValue(record: Record<string, unknown>): string {
  return recordString(record, "signingPublicKey", "signing_public_key");
}

function versionRank(version: string): bigint | null {
  return /^\d+$/.test(version) ? BigInt(version) : null;
}

function newestRecord(
  records: Record<string, unknown>[],
): Record<string, unknown> | null {
  return (
    records.toSorted((left, right) => {
      const a = publicKeyVersion(left);
      const b = publicKeyVersion(right);
      const an = versionRank(a);
      const bn = versionRank(b);
      if (an !== null && bn !== null && an !== bn) return an > bn ? -1 : 1;
      return b.localeCompare(a);
    })[0] ?? null
  );
}

function recordJuiceboxConfig(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const value = record.juiceboxConfig ?? record.juicebox_config;
  if (!isRecord(value)) {
    throw new Error(
      `X Chat public key version ${publicKeyVersion(record) || "unknown"} has no Juicebox configuration. ` +
        "The saved private identity was not discarded; rerun configure to reconcile it.",
    );
  }
  return normalizeJuiceboxConfig(value);
}

function normalizeJuiceboxConfig(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...value,
    ...(value.key_store_token_map_json === undefined &&
    value.keyStoreTokenMapJson !== undefined
      ? { key_store_token_map_json: value.keyStoreTokenMapJson }
      : {}),
    ...(value.token_map === undefined && value.tokenMap !== undefined
      ? { token_map: value.tokenMap }
      : {}),
    ...(value.max_guess_count === undefined && value.maxGuessCount !== undefined
      ? { max_guess_count: value.maxGuessCount }
      : {}),
  };
}

function createRealmTokenGetter(config: Record<string, unknown>): {
  getAuthToken: (realmId: string) => Promise<string>;
  getAuthTokenBytes: (realmId: Uint8Array) => Promise<string>;
} {
  const tokens = new Map<string, string>();
  const tokenMap = config.token_map ?? config.tokenMap;
  if (Array.isArray(tokenMap)) {
    for (const entry of tokenMap) {
      if (!isRecord(entry) || !isRecord(entry.value)) continue;
      const realm =
        typeof entry.key === "string" ? entry.key.toLowerCase() : "";
      const token = entry.value.token;
      if (realm && typeof token === "string") tokens.set(realm, token);
    }
  }
  const lookup = (realmId: string): string =>
    tokens.get(realmId.toLowerCase()) ?? "";
  return {
    getAuthToken: async (realmId) => lookup(String(realmId)),
    getAuthTokenBytes: async (realmId) =>
      lookup(Buffer.from(realmId).toString("hex")),
  };
}

function validateRegistrationPin(pin: string): void {
  const bytes = new TextEncoder().encode(pin);
  try {
    if (bytes.length < 4) {
      throw new Error("PIN must be at least 4 characters");
    }
    if (bytes.every((byte) => byte === bytes[0])) {
      throw new Error("PIN must not be a single repeated character");
    }
    const allDigits = bytes.every((byte) => byte >= 0x30 && byte <= 0x39);
    let ascending = true;
    let descending = true;
    for (let index = 1; index < bytes.length; index++) {
      if (bytes[index] !== (bytes[index - 1] ?? 0) + 1) ascending = false;
      if (bytes[index] !== (bytes[index - 1] ?? 0) - 1) descending = false;
    }
    if (allDigits && (ascending || descending)) {
      throw new Error("PIN must not be a sequential run of digits");
    }
  } finally {
    bytes.fill(0);
  }
}

function registrationBody(
  payload: XChatRegistrationPayloadLike,
): XChatPublicKeyRegistrationBody {
  const key = payload.publicKey;
  return {
    public_key: {
      identity_public_key_signature: key.identityPublicKeySignature,
      public_key: key.publicKey,
      public_key_fingerprint: key.publicKeyFingerprint,
      registration_method: key.registrationMethod,
      signing_public_key: key.signingPublicKey,
      signing_public_key_signature: key.signingPublicKeySignature,
    },
    version: String(payload.version),
    generate_version: Boolean(payload.generateVersion),
  };
}

function importCheckpointKeys(
  chat: XChatRawCryptoLike,
  checkpoint: XChatRegistrationCheckpoint,
): void {
  const privateKeys = Buffer.from(checkpoint.privateKeysBase64, "base64");
  try {
    chat.importKeys(privateKeys, checkpoint.registrationBody.version);
  } finally {
    // chat-xdk 0.5.0's generated JS does not zero the caller's buffer.
    privateKeys.fill(0);
  }
  const keys = chat.getPublicKeys();
  const publicKey = checkpoint.registrationBody.public_key;
  if (
    chat.getPublicKeyFingerprint() !== checkpoint.identityFingerprint ||
    keys.identity !== checkpoint.identityPublicKey ||
    keys.signing !== checkpoint.signingPublicKey ||
    !chat.matchesRegisteredKey(publicKey.public_key) ||
    !chat.verifyKeyBinding(
      publicKey.public_key,
      publicKey.signing_public_key,
      publicKey.identity_public_key_signature,
    )
  ) {
    throw new Error(
      "The saved X Chat registration checkpoint does not reproduce its recorded identity. " +
        "Refusing to generate or publish another key.",
    );
  }
}

function createCheckpoint(
  userId: string,
  chat: XChatRawCryptoLike,
): XChatRegistrationCheckpoint {
  const payload = chat.generateKeypairs();
  const privateKeys = chat.exportKeys();
  try {
    const keys = chat.getPublicKeys();
    const checkpoint: XChatRegistrationCheckpoint = {
      schemaVersion: 1,
      userId,
      createdAt: new Date().toISOString(),
      privateKeysBase64: Buffer.from(privateKeys).toString("base64"),
      identityFingerprint: chat.getPublicKeyFingerprint(),
      identityPublicKey: keys.identity,
      signingPublicKey: keys.signing,
      registrationBody: registrationBody(payload),
    };
    // This atomic fsync must complete before the rate-limited X write.
    writeXChatRegistrationCheckpoint(checkpoint);
    return checkpoint;
  } finally {
    privateKeys.fill(0);
  }
}

async function listPublicKeys(
  client: XChatApiClientLike,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const response = await client.users.getPublicKey(userId, {
    publicKeyFields: PUBLIC_KEY_FIELDS,
  });
  return Array.isArray(response.data) ? response.data : [];
}

function matchingRecord(
  chat: XChatRawCryptoLike,
  checkpoint: XChatRegistrationCheckpoint,
  records: Record<string, unknown>[],
): Record<string, unknown> | null {
  const signingKey = checkpoint.registrationBody.public_key.signing_public_key;
  return newestRecord(
    records.filter((record) => {
      if (
        checkpoint.registeredVersion &&
        publicKeyVersion(record) !== checkpoint.registeredVersion
      ) {
        return false;
      }
      const identityKey = publicKeyValue(record);
      if (!identityKey || !chat.matchesRegisteredKey(identityKey)) return false;
      const recordSigningKey = signingPublicKeyValue(record);
      return !recordSigningKey || recordSigningKey === signingKey;
    }),
  );
}

async function reconcileRegisteredKey(
  client: XChatApiClientLike,
  userId: string,
  chat: XChatRawCryptoLike,
  checkpoint: XChatRegistrationCheckpoint,
  wait: Waiter,
  poll: boolean,
): Promise<Record<string, unknown> | null> {
  const delays = poll ? REGISTRATION_RECONCILIATION_DELAYS_MS : [0];
  for (const delay of delays) {
    if (delay > 0) await wait(delay);
    const record = matchingRecord(
      chat,
      checkpoint,
      await listPublicKeys(client, userId),
    );
    if (record) return record;
  }
  return null;
}

function registrationResetAt(response: Response): Date | null {
  const raw = response.headers.get("x-user-limit-24hour-reset");
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value > 10_000_000_000 ? value : value * 1_000);
}

async function publishCheckpoint(
  botToken: string,
  userId: string,
  checkpoint: XChatRegistrationCheckpoint,
  fetchImpl: typeof fetch,
): Promise<Response> {
  // @xdevplatform/xdk 0.6.6 declares a raw-response overload for this route,
  // but its emitted addUserPublicKey implementation ignores the options
  // argument. Use the same OAuth2 bearer request directly so 429 reset headers
  // and ambiguous network outcomes remain observable to the state machine.
  return fetchImpl(
    `https://api.x.com/2/users/${encodeURIComponent(userId)}/public_keys`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
        "User-Agent": "letta-code-xchat/0.1",
      },
      body: JSON.stringify(checkpoint.registrationBody),
      signal: AbortSignal.timeout(30_000),
    },
  );
}

function juiceboxErrorReason(error: unknown): string {
  if (!isRecord(error)) return "";
  const raw = error.reason ?? error.reasonCode ?? error.code;
  if (typeof raw === "string") return raw;
  if (typeof raw !== "number") return "";
  return (
    [
      "InvalidAuth",
      "UpgradeRequired",
      "RateLimitExceeded",
      "Assertion",
      "Transient",
    ][raw] ?? ""
  );
}

async function verifyRecoveredIdentity(
  verifier: XChatJuiceboxChatLike,
  pin: string,
  record: Record<string, unknown>,
  checkpoint: XChatRegistrationCheckpoint,
): Promise<void> {
  await verifier.unlock(pin);
  const publicKey = publicKeyValue(record);
  const keys = verifier.getPublicKeys();
  if (
    !publicKey ||
    !verifier.matchesRegisteredKey(publicKey) ||
    verifier.getPublicKeyFingerprint() !== checkpoint.identityFingerprint ||
    keys.identity !== checkpoint.identityPublicKey ||
    keys.signing !== checkpoint.signingPublicKey
  ) {
    throw new Error(
      "Fresh Juicebox recovery returned a different X Chat identity. " +
        "The local checkpoint was kept; no new public key will be generated.",
    );
  }
}

async function storeAndVerifyWithJuicebox(
  record: Record<string, unknown>,
  checkpoint: XChatRegistrationCheckpoint,
  pin: string,
): Promise<void> {
  const config = recordJuiceboxConfig(record);
  const { getAuthToken, getAuthTokenBytes } = createRealmTokenGetter(config);
  const cryptoSdk = await loadXChatCryptoSdkModule();
  // createChat initializes the pinned Juicebox WASM module. This verifier is a
  // separate empty instance and must recover the keys from the realms below.
  const verifier = await cryptoSdk.createChat({
    juiceboxConfig: JSON.stringify(config),
    getAuthToken,
  });
  const juiceboxSdk = await loadXChatJuiceboxSdkModule();
  let configuration: XChatJuiceboxConfigurationLike | null =
    new juiceboxSdk.Configuration(cryptoSdk.juiceboxClientConfig(config));
  let client: XChatJuiceboxClientLike | null = null;
  try {
    client = new juiceboxSdk.Client(configuration, []);
    // The wasm-bindgen constructor consumes the Configuration pointer.
    configuration = null;
  } catch (error) {
    configuration?.free();
    verifier.free();
    throw error;
  }
  const globalWithJuicebox = globalThis as typeof globalThis & {
    JuiceboxGetAuthToken?: (realmId: Uint8Array) => Promise<string>;
  };
  const previousAuthTokenGetter = globalWithJuicebox.JuiceboxGetAuthToken;
  const privateKeys = Buffer.from(checkpoint.privateKeysBase64, "base64");
  const pinBytes = new TextEncoder().encode(pin);
  try {
    globalWithJuicebox.JuiceboxGetAuthToken = getAuthTokenBytes;
    try {
      await client.register(
        pinBytes,
        privateKeys,
        new Uint8Array(0),
        cryptoSdk.resolveMaxGuessCount(config),
      );
    } catch (registrationError) {
      // A threshold registration can complete even if the caller sees a
      // transient error. A successful fresh recovery is authoritative and
      // avoids an unnecessary second register call.
      try {
        await verifyRecoveredIdentity(verifier, pin, record, checkpoint);
        return;
      } catch (verificationError) {
        if (
          verificationError instanceof Error &&
          verificationError.message.includes("different X Chat identity")
        ) {
          throw verificationError;
        }
        throw registrationError;
      }
    }
    await verifyRecoveredIdentity(verifier, pin, record, checkpoint);
  } finally {
    privateKeys.fill(0);
    pinBytes.fill(0);
    if (previousAuthTokenGetter) {
      globalWithJuicebox.JuiceboxGetAuthToken = previousAuthTokenGetter;
    } else {
      delete globalWithJuicebox.JuiceboxGetAuthToken;
    }
    client.free();
    verifier.free();
  }
}

async function persistAndVerifyIdentity(
  client: XChatApiClientLike,
  userId: string,
  rawChat: XChatRawCryptoLike,
  checkpoint: XChatRegistrationCheckpoint,
  record: Record<string, unknown>,
  pin: string,
  wait: Waiter,
  status: StatusWriter,
): Promise<Record<string, unknown>> {
  let currentRecord = record;
  let lastError: unknown;
  for (let attempt = 0; attempt < JUICEBOX_RETRY_DELAYS_MS.length; attempt++) {
    const delay = JUICEBOX_RETRY_DELAYS_MS[attempt] ?? 0;
    if (delay > 0) {
      status(
        `Juicebox key storage was interrupted; retrying the same identity (${attempt + 1}/${JUICEBOX_RETRY_DELAYS_MS.length})...`,
      );
      await wait(delay);
      currentRecord =
        (await reconcileRegisteredKey(
          client,
          userId,
          rawChat,
          checkpoint,
          wait,
          false,
        )) ?? currentRecord;
    }
    try {
      await storeAndVerifyWithJuicebox(currentRecord, checkpoint, pin);
      return currentRecord;
    } catch (error) {
      lastError = error;
      if (
        error instanceof Error &&
        error.message.includes("different X Chat identity")
      ) {
        break;
      }
      const reason = juiceboxErrorReason(error);
      if (reason && reason !== "Transient" && reason !== "InvalidAuth") {
        break;
      }
    }
  }
  throw new Error(
    `The public key is registered, but storing the saved private identity in Juicebox failed. ` +
      `The local checkpoint was kept at ${dirname(getXChatRegistrationLockPath(userId))}; rerun configure to resume without creating another key.`,
    { cause: lastError },
  );
}

/**
 * Provision one X Chat identity with a write-ahead private-key checkpoint.
 * Every rerun imports and reconciles that exact identity before considering a
 * POST, so crashes, 429s, and partial Juicebox writes cannot orphan another
 * public key or mint a replacement accidentally.
 */
export async function provisionXChatIdentity(
  botToken: string,
  pin: string,
  options: ProvisionXChatIdentityOptions = {},
): Promise<ProvisionedXChatIdentity> {
  validateRegistrationPin(pin);
  const status = options.status ?? (() => {});
  const fetchImpl = options.fetch ?? fetch;
  const wait = options.wait ?? sleep;
  const xdk = await loadXChatXdkModule();
  const client = new xdk.Client({ accessToken: botToken });
  const me = await client.users.getMe();
  const userId = String(me.data?.id ?? "").trim();
  if (!userId) throw new Error("X API authentication returned no bot user ID.");

  ensureXChatRegistrationStateDir();
  const lockPath = getXChatRegistrationLockPath(userId);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  return withFileLock(
    lockPath,
    async () => {
      cleanupXChatRegistrationTemporaryFiles(userId);
      const rawModule = await loadXChatRawCryptoModule();
      const rawChat = new rawModule.Chat();
      try {
        let checkpoint = readXChatRegistrationCheckpoint(userId);
        const resumed = checkpoint !== null;
        if (checkpoint) {
          importCheckpointKeys(rawChat, checkpoint);
          status("Resuming the saved X Chat identity.");
        } else {
          checkpoint = createCheckpoint(userId, rawChat);
          status(
            "Generated one X Chat identity and saved its private-key checkpoint before publication.",
          );
        }

        let record = await reconcileRegisteredKey(
          client,
          userId,
          rawChat,
          checkpoint,
          wait,
          false,
        );
        if (!record) {
          status("Publishing the checkpointed X Chat public key once.");
          let response: Response | null = null;
          let requestError: unknown;
          try {
            response = await publishCheckpoint(
              botToken,
              userId,
              checkpoint,
              fetchImpl,
            );
          } catch (error) {
            requestError = error;
          }

          // A timed-out request may have committed. Reconcile the exact public
          // key before deciding what the response means or allowing a rerun.
          record = await reconcileRegisteredKey(
            client,
            userId,
            rawChat,
            checkpoint,
            wait,
            true,
          );
          if (!record) {
            if (response?.status === 429) {
              throw new XChatRegistrationRateLimitedError(
                registrationResetAt(response),
              );
            }
            if (requestError) {
              throw new Error(
                "The X public-key request ended without a confirmed response. " +
                  "The private identity was saved; rerun configure to reconcile and resume it safely.",
                { cause: requestError },
              );
            }
            if (!response?.ok) {
              throw new Error(
                `X rejected public-key registration with HTTP ${response?.status ?? "unknown"}. ` +
                  "The private identity was saved; rerun configure after resolving the API error.",
              );
            }
            throw new Error(
              "X accepted the public-key request, but the new record is not visible yet. " +
                "The private identity was saved; rerun configure to reconcile and resume it safely.",
            );
          }
        } else {
          status(
            `Found the checkpointed public key on X as version ${publicKeyVersion(record)}; no registration write was sent.`,
          );
        }

        const signingKeyVersion = publicKeyVersion(record);
        if (!signingKeyVersion) {
          throw new Error(
            "X returned the registered public key without a version. The local checkpoint was kept.",
          );
        }
        checkpoint = { ...checkpoint, registeredVersion: signingKeyVersion };
        writeXChatRegistrationCheckpoint(checkpoint);

        record = await persistAndVerifyIdentity(
          client,
          userId,
          rawChat,
          checkpoint,
          record,
          pin,
          wait,
          status,
        );
        status(
          `Fresh Juicebox recovery verified X Chat public key version ${signingKeyVersion}.`,
        );
        return {
          userId,
          ...(me.data?.username ? { username: me.data.username } : {}),
          signingKeyVersion,
          resumed,
        };
      } finally {
        rawChat.lock();
        rawChat.free();
      }
    },
    { staleMs: 10 * 60_000, timeoutMs: 10_000 },
  );
}

/** Delete a checkpoint only after ordinary adapter validation and account save. */
export function completeXChatRegistrationCheckpoint(
  userId: string,
  signingKeyVersion: string,
): boolean {
  const checkpoint = readXChatRegistrationCheckpoint(userId);
  if (!checkpoint || checkpoint.registeredVersion !== signingKeyVersion) {
    return false;
  }
  deleteXChatRegistrationCheckpoint(userId);
  return true;
}
