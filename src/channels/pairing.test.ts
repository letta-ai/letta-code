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
  rollbackPairingApproval,
} from "@/channels/pairing";

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
