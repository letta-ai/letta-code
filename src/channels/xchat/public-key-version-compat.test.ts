import { expect, test } from "bun:test";
import { patchXChatPublicKeyVersionSelection } from "./public-key-version-compat";
import type { XChatApiClientLike, XChatSdkAdapterLike } from "./runtime";

function makeClient(): XChatApiClientLike {
  return {
    chat: { getConversations: async () => ({ data: [] }) },
    users: {
      getMe: async () => ({ data: { id: "bot-user" } }),
      getPublicKey: async () => ({
        data: [{ publicKeyVersion: "100" }, { public_key_version: "200" }],
      }),
    },
  };
}

function makeAdapter(): XChatSdkAdapterLike & {
  xdkClient: XChatApiClientLike | null;
} {
  return {
    cryptoStatus: "ready",
    userName: "bot",
    xdkClient: null,
    initialize: async () => {},
    fetchMessages: async () => ({ messages: [] }),
    postMessage: async () => ({ id: "unused" }),
    addReaction: async () => {},
    removeReaction: async () => {},
  };
}

test("filters initial and refresh public-key responses to the pinned version", async () => {
  const adapter = makeAdapter();
  const assertPinned = patchXChatPublicKeyVersionSelection(adapter, "100");
  adapter.xdkClient = makeClient();
  assertPinned();

  const initial = await adapter.xdkClient.users.getPublicKey("bot-user", {
    publicKeyFields: ["public_key_version", "juicebox_config"],
  });
  const refresh = await adapter.xdkClient.users.getPublicKey("bot-user", {
    publicKeyFields: ["juicebox_config"],
  });

  expect(initial.data).toEqual([{ publicKeyVersion: "100" }]);
  expect(refresh.data).toEqual([{ publicKeyVersion: "100" }]);
});

test("fails closed when an adapter update bypasses the client hook", () => {
  const adapter = makeAdapter();
  const assertPinned = patchXChatPublicKeyVersionSelection(adapter, "100");

  expect(assertPinned).toThrow(
    "Refusing to continue with an unverified key/config pairing.",
  );
});

test("stops when the pinned public-key version is absent", async () => {
  const adapter = makeAdapter();
  patchXChatPublicKeyVersionSelection(adapter, "300");
  adapter.xdkClient = makeClient();

  await expect(
    adapter.xdkClient.users.getPublicKey("bot-user", {
      publicKeyFields: ["public_key_version", "juicebox_config"],
    }),
  ).rejects.toThrow(
    "X Chat public key version 300 was not found. Available versions: 100, 200.",
  );
});

test("does not filter participant signing-key responses", async () => {
  const adapter = makeAdapter();
  patchXChatPublicKeyVersionSelection(adapter, "100");
  adapter.xdkClient = makeClient();

  const response = await adapter.xdkClient.users.getPublicKey("peer-user", {
    publicKeyFields: [
      "public_key_version",
      "public_key",
      "signing_public_key",
      "identity_public_key_signature",
    ],
  });

  expect(response.data).toHaveLength(2);
});
