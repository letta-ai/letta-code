import { afterEach, expect, test } from "bun:test";
import {
  __testOverrideXChatRuntime,
  type XChatApiClientLike,
  type XChatSdkAdapterLike,
} from "./runtime";
import { resolveXChatCredentials, validateXChatCredentials } from "./setup";

afterEach(() => {
  __testOverrideXChatRuntime(null);
});

function makeSdkAdapter(params: {
  initialize?: () => Promise<void>;
  disconnect?: () => Promise<void>;
}): XChatSdkAdapterLike {
  const xdkClient: XChatApiClientLike = {
    chat: { getConversations: async () => ({ data: [] }) },
    users: {
      getMe: async () => ({ data: { id: "bot-user" } }),
      getPublicKey: async () => ({
        data: [{ publicKeyVersion: "100" }, { publicKeyVersion: "200" }],
      }),
    },
  };
  return {
    botUserId: "bot-user",
    cryptoStatus: "ready",
    userName: "co",
    initialize: params.initialize ?? (async () => {}),
    disconnect: params.disconnect,
    fetchMessages: async () => ({ messages: [] }),
    postMessage: async () => ({ id: "unused" }),
    addReaction: async () => {},
    removeReaction: async () => {},
    xdkClient,
  } as XChatSdkAdapterLike;
}

test("setup validates one exact key version through encrypted SDK initialization", async () => {
  let initialized = false;
  let configuredVersion: string | undefined;
  let disconnected = false;
  const adapter = makeSdkAdapter({
    initialize: async () => {
      initialized = true;
    },
    disconnect: async () => {
      disconnected = true;
    },
  });
  __testOverrideXChatRuntime({
    sdk: async () => ({
      createXchatAdapter: (config) => {
        configuredVersion = config.signingKeyVersion;
        return adapter;
      },
    }),
  });

  await expect(
    validateXChatCredentials("token", "1234", "100"),
  ).resolves.toEqual({
    userId: "bot-user",
    username: "co",
  });
  expect(initialized).toBe(true);
  expect(configuredVersion).toBe("100");
  expect(disconnected).toBe(true);
});

test("setup rejects an invalid PIN and disconnects before saving", async () => {
  let disconnected = false;
  const adapter = makeSdkAdapter({
    initialize: async () => {
      throw new Error("Juicebox recovery failed: reason=InvalidPin");
    },
    disconnect: async () => {
      disconnected = true;
    },
  });
  __testOverrideXChatRuntime({
    sdk: async () => ({ createXchatAdapter: () => adapter }),
  });

  await expect(validateXChatCredentials("token", "wrong")).rejects.toThrow(
    "InvalidPin",
  );
  expect(disconnected).toBe(true);
});

test("setup falls back to an older key only after NotRegistered", async () => {
  const attempts: string[] = [];
  __testOverrideXChatRuntime({
    sdk: async () => ({
      createXchatAdapter: (config) =>
        makeSdkAdapter({
          initialize: async () => {
            const version = config.signingKeyVersion ?? "";
            attempts.push(version);
            if (version === "200") {
              throw new Error("Juicebox recovery failed: reason=NotRegistered");
            }
          },
        }),
    }),
    xdk: async () => ({
      Client: class {
        chat = { getConversations: async () => ({ data: [] }) };
        users = {
          getMe: async () => ({ data: { id: "bot-user" } }),
          getPublicKey: async () => ({
            data: [{ publicKeyVersion: "100" }, { publicKeyVersion: "200" }],
          }),
        };
      },
    }),
  });

  await expect(resolveXChatCredentials("token", "1234")).resolves.toEqual({
    userId: "bot-user",
    username: "co",
    signingKeyVersion: "100",
  });
  expect(attempts).toEqual(["200", "100"]);
});

test("setup treats a stored key version as preferred but recoverable", async () => {
  const attempts: string[] = [];
  __testOverrideXChatRuntime({
    sdk: async () => ({
      createXchatAdapter: (config) =>
        makeSdkAdapter({
          initialize: async () => {
            const version = config.signingKeyVersion ?? "";
            attempts.push(version);
            if (version === "200") {
              throw new Error("Juicebox recovery failed: reason=NotRegistered");
            }
          },
        }),
    }),
    xdk: async () => ({
      Client: class {
        chat = { getConversations: async () => ({ data: [] }) };
        users = {
          getMe: async () => ({ data: { id: "bot-user" } }),
          getPublicKey: async () => ({
            data: [{ publicKeyVersion: "100" }, { publicKeyVersion: "200" }],
          }),
        };
      },
    }),
  });

  await expect(
    resolveXChatCredentials("token", "1234", "200", true),
  ).resolves.toMatchObject({ signingKeyVersion: "100" });
  expect(attempts).toEqual(["200", "100"]);
});

test("setup stops on an invalid PIN without trying older versions", async () => {
  const attempts: string[] = [];
  __testOverrideXChatRuntime({
    sdk: async () => ({
      createXchatAdapter: (config) =>
        makeSdkAdapter({
          initialize: async () => {
            attempts.push(config.signingKeyVersion ?? "");
            throw new Error("Juicebox recovery failed: reason=InvalidPin");
          },
        }),
    }),
    xdk: async () => ({
      Client: class {
        chat = { getConversations: async () => ({ data: [] }) };
        users = {
          getMe: async () => ({ data: { id: "bot-user" } }),
          getPublicKey: async () => ({
            data: [{ publicKeyVersion: "100" }, { publicKeyVersion: "200" }],
          }),
        };
      },
    }),
  });

  await expect(resolveXChatCredentials("token", "wrong")).rejects.toThrow(
    "InvalidPin",
  );
  expect(attempts).toEqual(["200"]);
});
