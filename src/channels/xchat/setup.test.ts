import { afterEach, expect, test } from "bun:test";
import {
  __testOverrideXChatRuntime,
  type XChatSdkAdapterLike,
} from "./runtime";
import { validateXChatCredentials } from "./setup";

afterEach(() => {
  __testOverrideXChatRuntime(null);
});

function makeSdkAdapter(params: {
  initialize?: () => Promise<void>;
  disconnect?: () => Promise<void>;
}): XChatSdkAdapterLike {
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
  };
}

test("setup validates the PIN through encrypted SDK initialization", async () => {
  let initialized = false;
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
    sdk: async () => ({ createXchatAdapter: () => adapter }),
  });

  await expect(validateXChatCredentials("token", "1234")).resolves.toEqual({
    userId: "bot-user",
    username: "co",
  });
  expect(initialized).toBe(true);
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
