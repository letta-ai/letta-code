import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
  consumePairingCode,
  createPairingCode,
  getApprovedUsers,
  getPendingPairings,
  isUserApproved,
  loadPairingStore,
  rollbackPairingApproval,
} from "@/channels/pairing";
import type { PairingStore } from "@/channels/types";

function loadPairingStoreFixture(channelId: string, store: PairingStore): void {
  __testOverrideLoadPairingStore(() => store);
  loadPairingStore(channelId);
}

describe("pairing", () => {
  beforeEach(() => {
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
  });

  afterEach(() => {
    clearPairingStores();
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
  });

  test("creates a pairing code for a user", () => {
    const code = createPairingCode("telegram", "user-1", "chat-1", "john");
    expect(code).toHaveLength(6);
    expect(/^[A-Z0-9]+$/.test(code)).toBe(true);

    const pending = getPendingPairings("telegram");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.code).toBe(code);
    expect(pending[0]?.senderId).toBe("user-1");
    expect(pending[0]?.chatId).toBe("chat-1");
  });

  test("consumes a valid pairing code", () => {
    const code = createPairingCode("telegram", "user-1", "chat-1", "john");

    const result = consumePairingCode("telegram", code);
    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("user-1");
    expect(result?.chatId).toBe("chat-1");

    // User should now be approved
    expect(isUserApproved("telegram", "user-1")).toBe(true);
    const approved = getApprovedUsers("telegram");
    expect(approved).toHaveLength(1);

    // Code should be consumed (pending cleared)
    const pending = getPendingPairings("telegram");
    expect(pending).toHaveLength(0);
  });

  test("rejects an invalid code", () => {
    createPairingCode("telegram", "user-1", "chat-1");

    const result = consumePairingCode("telegram", "INVALID");
    expect(result).toBeNull();
  });

  test("case-insensitive code matching", () => {
    const code = createPairingCode("telegram", "user-1", "chat-1");

    const result = consumePairingCode("telegram", code.toLowerCase());
    expect(result).not.toBeNull();
  });

  test("reuses the unexpired pending code for the same user", () => {
    const code1 = createPairingCode("telegram", "user-1", "chat-1");
    const code2 = createPairingCode("telegram", "user-1", "chat-1");

    // Rate limit: repeated messages do not mint new codes while the
    // sender's existing code is still valid.
    expect(code1).toBe(code2);
    expect(consumePairingCode("telegram", code1)).not.toBeNull();

    // Once consumed, a fresh request mints a new code.
    const code3 = createPairingCode("telegram", "user-1", "chat-1");
    expect(code3).not.toBe(code1);
  });

  test("reuses a pending code without retargeting chat or timestamps", () => {
    const createdAt = new Date(Date.now() - 14 * 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    loadPairingStoreFixture("telegram", {
      pending: [
        {
          accountId: "bot-a",
          code: "ABC234",
          senderId: "user-1",
          senderName: "original-name",
          chatId: "chat-original",
          createdAt,
          expiresAt,
        },
      ],
      approved: [],
    });

    const code = createPairingCode(
      "telegram",
      "user-1",
      "chat-later",
      "later-name",
      "bot-a",
    );

    expect(code).toBe("ABC234");
    const pending = getPendingPairings("telegram", "bot-a");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.chatId).toBe("chat-original");
    expect(pending[0]?.senderName).toBe("original-name");
    expect(pending[0]?.createdAt).toBe(createdAt);
    expect(pending[0]?.expiresAt).toBe(expiresAt);
  });

  test("generates a new code after the existing pending code expires", () => {
    const createdAt = new Date(Date.now() - 16 * 60_000).toISOString();
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    loadPairingStoreFixture("telegram", {
      pending: [
        {
          accountId: "bot-a",
          code: "XYZ789",
          senderId: "user-1",
          senderName: "old-name",
          chatId: "chat-old",
          createdAt,
          expiresAt,
        },
      ],
      approved: [],
    });

    const code = createPairingCode(
      "telegram",
      "user-1",
      "chat-new",
      "new-name",
      "bot-a",
    );

    expect(code).not.toBe("XYZ789");
    const pending = getPendingPairings("telegram", "bot-a");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.code).toBe(code);
    expect(pending[0]?.chatId).toBe("chat-new");
    expect(pending[0]?.senderName).toBe("new-name");
    expect(pending[0]?.createdAt).not.toBe(createdAt);
    expect(pending[0]?.expiresAt).not.toBe(expiresAt);
  });

  test("scopes pending-code reuse by sender and account", () => {
    const botAUser1 = createPairingCode(
      "telegram",
      "user-1",
      "chat-a1",
      "one",
      "bot-a",
    );
    const botAUser2 = createPairingCode(
      "telegram",
      "user-2",
      "chat-a2",
      "two",
      "bot-a",
    );
    const botBUser1 = createPairingCode(
      "telegram",
      "user-1",
      "chat-b1",
      "one-b",
      "bot-b",
    );

    expect(
      createPairingCode("telegram", "user-1", "ignored", "new", "bot-a"),
    ).toBe(botAUser1);

    const botAPending = getPendingPairings("telegram", "bot-a");
    expect(botAPending).toHaveLength(2);
    expect(botAPending[0]?.code).toBe(botAUser1);
    expect(botAPending[0]?.senderId).toBe("user-1");
    expect(botAPending[0]?.chatId).toBe("chat-a1");
    expect(botAPending[1]?.code).toBe(botAUser2);
    expect(botAPending[1]?.senderId).toBe("user-2");
    expect(botAPending[1]?.chatId).toBe("chat-a2");

    const botBPending = getPendingPairings("telegram", "bot-b");
    expect(botBPending).toHaveLength(1);
    expect(botBPending[0]?.code).toBe(botBUser1);
    expect(botBPending[0]?.senderId).toBe("user-1");
    expect(botBPending[0]?.chatId).toBe("chat-b1");
  });

  test("fails closed when duplicate pending codes are ambiguous", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    loadPairingStoreFixture("telegram", {
      pending: [
        {
          accountId: "bot-a",
          code: "DUP999",
          senderId: "user-1",
          chatId: "chat-1",
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt,
        },
        {
          accountId: "bot-a",
          code: "DUP999",
          senderId: "user-2",
          chatId: "chat-2",
          createdAt: new Date(Date.now() - 30_000).toISOString(),
          expiresAt,
        },
      ],
      approved: [],
    });

    expect(consumePairingCode("telegram", "dup999", "bot-a")).toBeNull();
    expect(getPendingPairings("telegram", "bot-a")).toHaveLength(2);
    expect(getApprovedUsers("telegram", "bot-a")).toHaveLength(0);
  });

  test("isUserApproved returns false for unknown users", () => {
    expect(isUserApproved("telegram", "unknown")).toBe(false);
  });

  test("rollbackPairingApproval restores pending and removes approved", () => {
    const code = createPairingCode("telegram", "user-1", "chat-1", "john");
    const pending = consumePairingCode("telegram", code);
    expect(pending).not.toBeNull();

    // User is now approved, no pending codes
    expect(isUserApproved("telegram", "user-1")).toBe(true);
    expect(getPendingPairings("telegram")).toHaveLength(0);

    // Roll back
    if (!pending) {
      throw new Error("Expected pending pairing to exist");
    }
    rollbackPairingApproval("telegram", pending);

    // User should no longer be approved, pending code restored
    expect(isUserApproved("telegram", "user-1")).toBe(false);
    expect(getPendingPairings("telegram")).toHaveLength(1);
    expect(getPendingPairings("telegram")[0]?.code).toBe(code);
  });
});
