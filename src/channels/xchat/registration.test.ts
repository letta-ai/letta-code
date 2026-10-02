import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  completeXChatRegistrationCheckpoint,
  provisionXChatIdentity,
  XChatRegistrationRateLimitedError,
} from "./registration";
import {
  getXChatRegistrationCheckpointPath,
  type XChatRegistrationCheckpoint,
} from "./registration-state";
import {
  __testOverrideXChatRuntime,
  type XChatCryptoSdkModuleLike,
  type XChatJuiceboxSdkModuleLike,
  type XChatRawCryptoLike,
  type XChatRawCryptoModuleLike,
  type XChatXdkModuleLike,
} from "./runtime";

type PublishBehavior = "success" | "network-error" | "rate-limit";

interface FakeRegistrationWorld {
  generated: number;
  juiceboxCommitThenFail: boolean;
  juiceboxSecret: Uint8Array | null;
  juiceboxFailuresRemaining: number;
  postCount: number;
  publishBehavior: PublishBehavior;
  records: Record<string, unknown>[];
}

function identityNumberFromPublicKey(publicKey: string): number {
  return Number(publicKey.split("-").at(-1));
}

function recordFromCheckpoint(
  checkpoint: XChatRegistrationCheckpoint,
  version = "2001",
): Record<string, unknown> {
  return {
    publicKeyVersion: version,
    publicKey: checkpoint.registrationBody.public_key.public_key,
    signingPublicKey: checkpoint.registrationBody.public_key.signing_public_key,
    juiceboxConfig: {
      key_store_token_map_json: JSON.stringify({
        realms: [{ id: "aa", address: "https://realm.invalid" }],
        register_threshold: 1,
        recover_threshold: 1,
        pin_hashing_mode: "FastInsecure",
      }),
      max_guess_count: 20,
      token_map: [
        {
          key: "aa",
          value: { address: "https://realm.invalid", token: "realm-token" },
        },
      ],
    },
  };
}

function createFakeRawCryptoModule(
  world: FakeRegistrationWorld,
): XChatRawCryptoModuleLike {
  class FakeRawChat implements XChatRawCryptoLike {
    private identity = 0;

    exportKeys(): Uint8Array {
      return new Uint8Array(64).fill(this.identity);
    }

    free(): void {}

    generateKeypairs() {
      world.generated += 1;
      this.identity = world.generated + 10;
      return {
        publicKey: {
          identityPublicKeySignature: `identity-signature-${this.identity}`,
          publicKey: `public-key-${this.identity}`,
          publicKeyFingerprint: `fingerprint-${this.identity}`,
          registrationMethod: "CustomPin",
          signingPublicKey: `wire-signing-key-${this.identity}`,
          signingPublicKeySignature: `signing-signature-${this.identity}`,
        },
        version: `generated-${this.identity}`,
        generateVersion: true,
      };
    }

    getPublicKeyFingerprint(): string {
      return `fingerprint-${this.identity}`;
    }

    getPublicKeys() {
      return {
        identity: `identity-${this.identity}`,
        signing: `signing-${this.identity}`,
        version: `generated-${this.identity}`,
      };
    }

    importKeys(keys: Uint8Array): void {
      this.identity = keys[0] ?? 0;
    }

    lock(): void {
      this.identity = 0;
    }

    matchesRegisteredKey(publicKey: string): boolean {
      return publicKey === `public-key-${this.identity}`;
    }

    verifyKeyBinding(
      identityPublicKey: string,
      signingPublicKey: string,
      identityPublicKeySignature: string,
    ): boolean {
      return (
        identityPublicKey === `public-key-${this.identity}` &&
        signingPublicKey === `wire-signing-key-${this.identity}` &&
        identityPublicKeySignature === `identity-signature-${this.identity}`
      );
    }
  }

  return {
    Chat: FakeRawChat,
    async default() {},
  };
}

function createFakeCryptoSdk(
  world: FakeRegistrationWorld,
): XChatCryptoSdkModuleLike {
  return {
    async createChat() {
      let identity = 0;
      return {
        free() {},
        getPublicKeyFingerprint() {
          return `fingerprint-${identity}`;
        },
        getPublicKeys() {
          return {
            identity: `identity-${identity}`,
            signing: `signing-${identity}`,
            version: "recovered",
          };
        },
        matchesRegisteredKey(publicKey: string) {
          return identityNumberFromPublicKey(publicKey) === identity;
        },
        async unlock() {
          if (!world.juiceboxSecret) {
            throw Object.assign(new Error("NotRegistered"), { reason: 1 });
          }
          identity = world.juiceboxSecret[0] ?? 0;
        },
      };
    },
    juiceboxClientConfig(config) {
      return config;
    },
    resolveMaxGuessCount() {
      return 20;
    },
  };
}

function createFakeJuiceboxSdk(
  world: FakeRegistrationWorld,
): XChatJuiceboxSdkModuleLike {
  class FakeConfiguration {
    free(): void {}
  }
  class FakeClient {
    free(): void {}

    async register(_pin: Uint8Array, secret: Uint8Array): Promise<void> {
      if (world.juiceboxCommitThenFail) {
        world.juiceboxCommitThenFail = false;
        world.juiceboxSecret = Uint8Array.from(secret);
        throw Object.assign(new Error("response lost"), { reason: 4 });
      }
      if (world.juiceboxFailuresRemaining > 0) {
        world.juiceboxFailuresRemaining -= 1;
        throw Object.assign(new Error("transient"), { reason: 4 });
      }
      world.juiceboxSecret = Uint8Array.from(secret);
    }
  }
  return {
    Client: FakeClient,
    Configuration: FakeConfiguration,
  };
}

function createFakeXdk(world: FakeRegistrationWorld): XChatXdkModuleLike {
  return {
    Client: class {
      users = {
        getMe: async () => ({ data: { id: "42", username: "testbot" } }),
        getPublicKey: async () => ({ data: world.records }),
      };

      chat = {
        getConversations: async () => ({ data: [] }),
      };
    },
  } as unknown as XChatXdkModuleLike;
}

function createFakeFetch(world: FakeRegistrationWorld): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    world.postCount += 1;
    if (world.publishBehavior === "network-error") {
      throw new Error("connection reset");
    }
    if (world.publishBehavior === "rate-limit") {
      return new Response("", {
        status: 429,
        headers: { "x-user-limit-24hour-reset": "1893456000" },
      });
    }
    const body = JSON.parse(String(init?.body)) as {
      public_key: {
        public_key: string;
        signing_public_key: string;
      };
    };
    world.records.push({
      publicKeyVersion: String(2000 + world.postCount),
      publicKey: body.public_key.public_key,
      signingPublicKey: body.public_key.signing_public_key,
      juiceboxConfig: recordFromCheckpoint(
        JSON.parse(
          readFileSync(getXChatRegistrationCheckpointPath("42"), "utf8"),
        ) as XChatRegistrationCheckpoint,
      ).juiceboxConfig,
    });
    return new Response("", { status: 200 });
  }) as typeof fetch;
}

function provision(world: FakeRegistrationWorld, pin = "safe-pin") {
  return provisionXChatIdentity("token", pin, {
    fetch: createFakeFetch(world),
    wait: async () => {},
  });
}

function installFakes(world: FakeRegistrationWorld): void {
  __testOverrideXChatRuntime({
    xdk: async () => createFakeXdk(world),
    rawCrypto: async () => createFakeRawCryptoModule(world),
    cryptoSdk: async () => createFakeCryptoSdk(world),
    juiceboxSdk: async () => createFakeJuiceboxSdk(world),
  });
}

function newWorld(): FakeRegistrationWorld {
  return {
    generated: 0,
    juiceboxCommitThenFail: false,
    juiceboxSecret: null,
    juiceboxFailuresRemaining: 0,
    postCount: 0,
    publishBehavior: "success",
    records: [],
  };
}

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "letta-xchat-registration-"));
  __testOverrideChannelsRoot(root);
});

afterEach(() => {
  __testOverrideXChatRuntime(null);
  __testOverrideChannelsRoot(null);
  rmSync(root, { recursive: true, force: true });
});

describe("crash-safe X Chat registration", () => {
  test.each(["123", "1111", "1234", "4321"])(
    "rejects weak PIN %s before generating or publishing a key",
    async (pin) => {
      const world = newWorld();
      installFakes(world);

      await expect(provision(world, pin)).rejects.toThrow("PIN must");
      expect(world.generated).toBe(0);
      expect(world.postCount).toBe(0);
    },
  );

  test("resumes one checkpoint after an ambiguous POST without minting again", async () => {
    const world = newWorld();
    world.publishBehavior = "network-error";
    installFakes(world);

    await expect(provision(world)).rejects.toThrow(
      "without a confirmed response",
    );
    expect(world.generated).toBe(1);
    expect(world.postCount).toBe(1);

    const checkpoint = JSON.parse(
      readFileSync(getXChatRegistrationCheckpointPath("42"), "utf8"),
    ) as XChatRegistrationCheckpoint;
    world.records.push(recordFromCheckpoint(checkpoint));
    world.publishBehavior = "success";

    const resumed = await provision(world);
    expect(resumed).toMatchObject({
      resumed: true,
      signingKeyVersion: "2001",
      userId: "42",
    });
    expect(world.generated).toBe(1);
    expect(world.postCount).toBe(1);
    expect(completeXChatRegistrationCheckpoint("42", "2001")).toBe(true);
  });

  test("keeps the same private identity across a 429 and later retry", async () => {
    const world = newWorld();
    world.publishBehavior = "rate-limit";
    installFakes(world);

    const first = provision(world);
    await expect(first).rejects.toBeInstanceOf(
      XChatRegistrationRateLimitedError,
    );
    expect(world.generated).toBe(1);
    expect(world.postCount).toBe(1);

    world.publishBehavior = "success";
    const resumed = await provision(world);
    expect(resumed.resumed).toBe(true);
    expect(world.generated).toBe(1);
    expect(world.postCount).toBe(2);
  });

  test("resumes after Juicebox fails following a successful X write", async () => {
    const world = newWorld();
    world.juiceboxFailuresRemaining = 5;
    installFakes(world);

    await expect(provision(world)).rejects.toThrow(
      "storing the saved private identity in Juicebox failed",
    );
    expect(world.generated).toBe(1);
    expect(world.postCount).toBe(1);

    world.juiceboxFailuresRemaining = 0;
    const resumed = await provision(world);
    expect(resumed.resumed).toBe(true);
    expect(world.generated).toBe(1);
    expect(world.postCount).toBe(1);
  });

  test("accepts fresh recovery after a transient Juicebox response loss", async () => {
    const world = newWorld();
    world.juiceboxCommitThenFail = true;
    installFakes(world);

    const provisioned = await provision(world);
    expect(provisioned.signingKeyVersion).toBe("2001");
    expect(world.generated).toBe(1);
    expect(world.postCount).toBe(1);
  });

  test("writes the checkpoint with owner-only permissions before POST", async () => {
    if (process.platform === "win32") return;
    const world = newWorld();
    world.publishBehavior = "network-error";
    installFakes(world);

    await expect(provision(world)).rejects.toThrow();
    const mode =
      statSync(getXChatRegistrationCheckpointPath("42")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("refuses to replace a corrupt private-key checkpoint", async () => {
    const world = newWorld();
    installFakes(world);
    const checkpointPath = getXChatRegistrationCheckpointPath("42");
    const registrationDir = join(root, "xchat", "registration");
    mkdirSync(registrationDir, { recursive: true });
    writeFileSync(checkpointPath, "{not-json", "utf8");

    await expect(provision(world)).rejects.toThrow(
      "only copy of a private identity",
    );
    expect(readFileSync(checkpointPath, "utf8")).toBe("{not-json");
    expect(world.generated).toBe(0);
    expect(world.postCount).toBe(0);
  });

  test("refuses a checkpoint whose public registration no longer binds to its private identity", async () => {
    const world = newWorld();
    world.publishBehavior = "network-error";
    installFakes(world);

    await expect(provision(world)).rejects.toThrow();
    const checkpointPath = getXChatRegistrationCheckpointPath("42");
    const checkpoint = JSON.parse(
      readFileSync(checkpointPath, "utf8"),
    ) as XChatRegistrationCheckpoint;
    checkpoint.registrationBody.public_key.identity_public_key_signature =
      "tampered-signature";
    writeFileSync(checkpointPath, JSON.stringify(checkpoint), "utf8");

    await expect(provision(world)).rejects.toThrow(
      "does not reproduce its recorded identity",
    );
    expect(world.generated).toBe(1);
    expect(world.postCount).toBe(1);
  });
});
