import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InboundIdentityContext,
  resolveInboundChatId,
} from "./inbound-identity";
import { LidDesk } from "./lid-desk";

// ── Helpers ─────────────────────────────────────────────────────────

let tempDir: string;

function makeCtx(
  overrides: Partial<InboundIdentityContext> = {},
): InboundIdentityContext {
  return {
    selfPhoneJid: null,
    lidDesk: new LidDesk(tempDir),
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inbound-identity-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────

describe("resolveInboundChatId", () => {
  test("LID remoteJid → resolves to PN via msg.key.senderPn", () => {
    const ctx = makeCtx();
    const result = resolveInboundChatId(ctx, "1234567890:1@lid", false, {
      key: { senderPn: "584149145006@s.whatsapp.net" },
    });
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("LID remoteJid → records resolved mapping to LidDesk", () => {
    const lidDesk = new LidDesk(tempDir);
    const ctx = makeCtx({ lidDesk });
    resolveInboundChatId(ctx, "1111111111:2@lid", false, {
      key: { senderPn: "584149145006@s.whatsapp.net" },
    });
    expect(lidDesk.resolveLid("1111111111@lid")).toBe(
      "584149145006@s.whatsapp.net",
    );
  });

  test("LID remoteJid → returns desk-resolved PN when desk already has mapping", () => {
    const lidDesk = new LidDesk(tempDir);
    lidDesk.record("2222222222@lid", "584149145006@s.whatsapp.net");
    const ctx = makeCtx({ lidDesk });
    const result = resolveInboundChatId(ctx, "2222222222:3@lid", false, {
      key: {},
    });
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("LID remoteJid → returns stripped LID when no resolution possible", () => {
    const ctx = makeCtx();
    const result = resolveInboundChatId(ctx, "3333333333:7@lid", false, {
      key: {},
    });
    expect(result).toBe("3333333333@lid");
  });

  test("PN remoteJid → returns as-is (device suffix stripped)", () => {
    const ctx = makeCtx();
    const result = resolveInboundChatId(
      ctx,
      "584149145006:9@s.whatsapp.net",
      false,
      { key: {} },
    );
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("self-chat → returns selfPhoneJid when set", () => {
    const ctx = makeCtx({ selfPhoneJid: "584149145006@s.whatsapp.net" });
    const result = resolveInboundChatId(
      ctx,
      "584149145006:1@s.whatsapp.net",
      true,
      { key: {} },
    );
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("self-chat → derives from remoteJid when selfPhoneJid is null", () => {
    const ctx = makeCtx({ selfPhoneJid: null });
    const result = resolveInboundChatId(
      ctx,
      "584149145006:1@s.whatsapp.net",
      true,
      { key: {} },
    );
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("group remoteJid → strips device suffix and returns", () => {
    // Note: in the adapter, group JIDs are handled by a stripDeviceSuffix
    // call BEFORE resolveInboundChatId is invoked. But if a group JID
    // somehow reaches this function, it should still just strip the
    // device suffix and return.
    const ctx = makeCtx();
    const result = resolveInboundChatId(ctx, "120363000000000000@g.us", false, {
      key: {},
    });
    expect(result).toBe("120363000000000000@g.us");
  });

  test("strips device suffix from non-LID, non-self JIDs", () => {
    const ctx = makeCtx();
    const result = resolveInboundChatId(
      ctx,
      "584149145006:14@s.whatsapp.net",
      false,
      { key: {} },
    );
    expect(result).toBe("584149145006@s.whatsapp.net");
  });
});
