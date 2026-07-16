import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSendJid } from "./jid";
import { LidDesk, type OnWhatsAppSocket } from "./lid-desk";

// ── Helpers ─────────────────────────────────────────────────────────

let tempDir: string;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "lid-desk-test-"));
}

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────

describe("LidDesk — mining from messages", () => {
  test("Source 1: remoteJid is a LID + senderPn", () => {
    const desk = new LidDesk(tempDir);
    const changed = desk.mineFromMessage({
      key: {
        remoteJid: "1234567890:1@lid",
        senderPn: "584149145006@s.whatsapp.net",
      },
    });
    expect(changed).toBe(true);
    expect(desk.resolveLid("1234567890:1@lid")).toBe(
      "584149145006@s.whatsapp.net",
    );
    // Device suffix normalization
    expect(desk.resolveLid("1234567890@lid")).toBe(
      "584149145006@s.whatsapp.net",
    );
  });

  test("Source 2: participant is a LID + senderPn (group context)", () => {
    const desk = new LidDesk(tempDir);
    desk.mineFromMessage({
      key: {
        remoteJid: "group@g.us",
        participant: "8888888888@lid",
        senderPn: "584149145006@s.whatsapp.net",
      },
    });
    expect(desk.resolveLid("8888888888@lid")).toBe(
      "584149145006@s.whatsapp.net",
    );
  });

  test("Source 3: remoteJid is a LID + participant is a phone JID", () => {
    const desk = new LidDesk(tempDir);
    desk.mineFromMessage({
      key: {
        remoteJid: "9999999999@lid",
        participant: "584149145006@s.whatsapp.net",
      },
    });
    expect(desk.resolveLid("9999999999@lid")).toBe(
      "584149145006@s.whatsapp.net",
    );
  });

  test("Source 4: participantLid + participantPn (explicit group LID/PN fields)", () => {
    const desk = new LidDesk(tempDir);
    desk.mineFromMessage({
      key: {
        remoteJid: "group@g.us",
        participantLid: "7777777@lid",
        participantPn: "584149145006@s.whatsapp.net",
      },
    });
    expect(desk.resolveLid("7777777@lid")).toBe("584149145006@s.whatsapp.net");
  });

  test("Source 4: participantLid with device suffix is normalized", () => {
    const desk = new LidDesk(tempDir);
    desk.mineFromMessage({
      key: {
        remoteJid: "group@g.us",
        participantLid: "7777777:3@lid",
        participantPn: "584149145006:2@s.whatsapp.net",
      },
    });
    expect(desk.resolveLid("7777777:3@lid")).toBe(
      "584149145006@s.whatsapp.net",
    );
    expect(desk.resolveLid("7777777@lid")).toBe("584149145006@s.whatsapp.net");
  });

  test("mines from multiple sources in a single message", () => {
    const desk = new LidDesk(tempDir);
    // A group message where remoteJid is LID, participant is LID, senderPn present,
    // and participantLid/participantPn also present — should mine multiple mappings.
    const changed = desk.mineFromMessage({
      key: {
        remoteJid: "1111111@lid",
        participant: "2222222@lid",
        senderPn: "584149145006@s.whatsapp.net",
        participantLid: "2222222@lid",
        participantPn: "584149145006@s.whatsapp.net",
      },
    });
    expect(changed).toBe(true);
    // Both LIDs should map to the same phone
    expect(desk.resolveLid("1111111@lid")).toBe("584149145006@s.whatsapp.net");
    expect(desk.resolveLid("2222222@lid")).toBe("584149145006@s.whatsapp.net");
  });

  test("returns false when nothing mineable", () => {
    const desk = new LidDesk(tempDir);
    expect(
      desk.mineFromMessage({ key: { remoteJid: "123@s.whatsapp.net" } }),
    ).toBe(false);
    expect(desk.mineFromMessage({})).toBe(false);
    expect(desk.mineFromMessage({ key: null })).toBe(false);
  });

  test("does not re-record identical mapping (idempotent)", () => {
    const desk = new LidDesk(tempDir);
    const msg = {
      key: {
        remoteJid: "1234567890@lid",
        senderPn: "584149145006@s.whatsapp.net",
      },
    };
    expect(desk.mineFromMessage(msg)).toBe(true);
    expect(desk.mineFromMessage(msg)).toBe(false);
  });

  test("participantLid without participantPn does not crash (skipped)", () => {
    const desk = new LidDesk(tempDir);
    expect(
      desk.mineFromMessage({
        key: {
          remoteJid: "group@g.us",
          participantLid: "7777777@lid",
        },
      }),
    ).toBe(false);
  });

  test("participantPn without participantLid does not crash (skipped)", () => {
    const desk = new LidDesk(tempDir);
    expect(
      desk.mineFromMessage({
        key: {
          remoteJid: "group@g.us",
          participantPn: "584149145006@s.whatsapp.net",
        },
      }),
    ).toBe(false);
  });
});

describe("LidDesk — JSON persistence round-trip", () => {
  test("save → load preserves all mappings", () => {
    const desk = new LidDesk(tempDir);
    desk.record("aaa@lid", "1111111111@s.whatsapp.net");
    desk.record("bbb@lid", "2222222222@s.whatsapp.net");
    desk.save();

    // File exists and is valid JSON
    const filePath = join(tempDir, "lid-mappings.json");
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.lidToJid).toEqual({
      "aaa@lid": "1111111111@s.whatsapp.net",
      "bbb@lid": "2222222222@s.whatsapp.net",
    });

    // Load into a fresh instance
    const desk2 = new LidDesk(tempDir);
    desk2.load();
    expect(desk2.resolveLid("aaa@lid")).toBe("1111111111@s.whatsapp.net");
    expect(desk2.resolveLid("bbb@lid")).toBe("2222222222@s.whatsapp.net");
    expect(desk2.resolvePn("1111111111@s.whatsapp.net")).toBe("aaa@lid");
    expect(desk2.resolvePn("2222222222@s.whatsapp.net")).toBe("bbb@lid");
    expect(desk2.size).toBe(2);
  });

  test("load is no-op when file does not exist", () => {
    const desk = new LidDesk(tempDir);
    desk.load();
    expect(desk.size).toBe(0);
  });

  test("corrupt JSON starts empty (no throw)", () => {
    const filePath = join(tempDir, "lid-mappings.json");
    writeFileSync(filePath, "{ not valid json !!!");
    const desk = new LidDesk(tempDir);
    desk.load();
    expect(desk.size).toBe(0);
  });

  test("save only writes when dirty", () => {
    const desk = new LidDesk(tempDir);
    desk.save(); // should not throw, should be no-op
    expect(existsSync(join(tempDir, "lid-mappings.json"))).toBe(false);

    desk.record("xxx@lid", "9999999999@s.whatsapp.net");
    desk.save();
    expect(existsSync(join(tempDir, "lid-mappings.json"))).toBe(true);
  });

  test("device suffix normalization on record and resolve", () => {
    const desk = new LidDesk(tempDir);
    desk.record("1234567890:2@lid", "584149145006:3@s.whatsapp.net");
    // Resolve with or without device suffix
    expect(desk.resolveLid("1234567890:2@lid")).toBe(
      "584149145006@s.whatsapp.net",
    );
    expect(desk.resolveLid("1234567890@lid")).toBe(
      "584149145006@s.whatsapp.net",
    );
    // Reverse lookup also normalizes
    expect(desk.resolvePn("584149145006:5@s.whatsapp.net")).toBe(
      "1234567890@lid",
    );
  });
});

describe("LidDesk — resolveSendJid integration", () => {
  test("resolveSendJid succeeds on LID when desk has the mapping", () => {
    const desk = new LidDesk(tempDir);
    desk.record("555555@lid", "584149145006@s.whatsapp.net");
    const lidToJid = desk.getLidToJidMap();

    const result = resolveSendJid({
      chatId: "555555@lid",
      selfPhoneJid: null,
      selfLid: null,
      lidToJid,
    });
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("resolveSendJid still throws when mapping unknown (preserves current behavior)", () => {
    const desk = new LidDesk(tempDir);
    const lidToJid = desk.getLidToJidMap();

    expect(() =>
      resolveSendJid({
        chatId: "unknown@lid",
        selfPhoneJid: null,
        selfLid: null,
        lidToJid,
      }),
    ).toThrow(/Cannot send to unresolved WhatsApp LID/);
  });

  test("resolveSendJid passes through for non-LID chatId", () => {
    const desk = new LidDesk(tempDir);
    const result = resolveSendJid({
      chatId: "584149145006@s.whatsapp.net",
      selfPhoneJid: null,
      selfLid: null,
      lidToJid: desk.getLidToJidMap(),
    });
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("resolveSendJid resolves self-LID to self-phone when self mapping known", () => {
    const desk = new LidDesk(tempDir);
    const result = resolveSendJid({
      chatId: "mylid@lid",
      selfPhoneJid: "15551234567@s.whatsapp.net",
      selfLid: "mylid@lid",
      lidToJid: desk.getLidToJidMap(),
    });
    expect(result).toBe("15551234567@s.whatsapp.net");
  });
});

describe("LidDesk — clear", () => {
  test("clear empties all mappings and marks dirty", () => {
    const desk = new LidDesk(tempDir);
    desk.record("a@lid", "1@s.whatsapp.net");
    desk.record("b@lid", "2@s.whatsapp.net");
    expect(desk.size).toBe(2);

    desk.clear();
    expect(desk.size).toBe(0);
    expect(desk.resolveLid("a@lid")).toBeNull();
    expect(desk.resolvePn("1@s.whatsapp.net")).toBeNull();

    // save() should now write an empty file
    desk.save();
    const raw = JSON.parse(
      readFileSync(join(tempDir, "lid-mappings.json"), "utf8"),
    );
    expect(raw.lidToJid).toEqual({});
    expect(raw.jidToLid).toEqual({});
  });

  test("clear is no-op when already empty", () => {
    const desk = new LidDesk(tempDir);
    desk.clear();
    // No file should be written
    desk.save();
    expect(existsSync(join(tempDir, "lid-mappings.json"))).toBe(false);
  });
});

describe("LidDesk — reverse map (jidToLid) for presence", () => {
  test("getJidToLidMap returns phone→lid mapping", () => {
    const desk = new LidDesk(tempDir);
    desk.record("ccc@lid", "3333333333@s.whatsapp.net");
    const jidToLid = desk.getJidToLidMap();
    expect(jidToLid.get("3333333333@s.whatsapp.net")).toBe("ccc@lid");
  });
});

// ── lookupLidForPhone tests ─────────────────────────────────────────

describe("LidDesk — lookupLidForPhone", () => {
  function makeMockSocket(
    responseMap: Record<
      string,
      { exists: boolean; jid?: string; lid?: string }
    >,
  ): OnWhatsAppSocket {
    return {
      onWhatsApp: async (phone: string) => {
        const r = responseMap[phone];
        return r ? [r] : [];
      },
    };
  }

  test("cache hit short-circuits — does not call onWhatsApp", async () => {
    const desk = new LidDesk(tempDir);
    desk.record("999111@lid", "5551112222@s.whatsapp.net");

    let callCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => {
        callCount++;
        return [
          {
            exists: true,
            jid: "5551112222@s.whatsapp.net",
            lid: "different@lid",
          },
        ];
      },
    };

    const result = await desk.lookupLidForPhone(
      "5551112222@s.whatsapp.net",
      sock,
    );
    expect(result).toBe("999111@lid");
    expect(callCount).toBe(0); // onWhatsApp was NOT called
  });

  test("cache miss + onWhatsApp success persists mapping", async () => {
    const desk = new LidDesk(tempDir);
    const sock = makeMockSocket({
      "5552223333@s.whatsapp.net": {
        exists: true,
        jid: "5552223333@s.whatsapp.net",
        lid: "777888@lid",
      },
    });

    const result = await desk.lookupLidForPhone(
      "5552223333@s.whatsapp.net",
      sock,
    );
    expect(result).toBe("777888@lid");

    // Mapping persisted
    expect(desk.resolvePn("5552223333@s.whatsapp.net")).toBe("777888@lid");
    expect(desk.resolveLid("777888@lid")).toBe("5552223333@s.whatsapp.net");

    // File on disk
    desk.save();
    const raw = JSON.parse(
      readFileSync(join(tempDir, "lid-mappings.json"), "utf8"),
    );
    expect(raw.jidToLid["5552223333@s.whatsapp.net"]).toBe("777888@lid");
  });

  test("cache miss + onWhatsApp returns exists:false does not persist", async () => {
    const desk = new LidDesk(tempDir);
    const sock = makeMockSocket({
      "5553334444@s.whatsapp.net": { exists: false },
    });

    const result = await desk.lookupLidForPhone(
      "5553334444@s.whatsapp.net",
      sock,
    );
    expect(result).toBeNull();
    expect(desk.resolvePn("5553334444@s.whatsapp.net")).toBeNull();
    expect(desk.size).toBe(0);
  });

  test("cache miss + onWhatsApp returns empty array does not persist", async () => {
    const desk = new LidDesk(tempDir);
    const sock = makeMockSocket({});

    const result = await desk.lookupLidForPhone(
      "5554445555@s.whatsapp.net",
      sock,
    );
    expect(result).toBeNull();
    expect(desk.size).toBe(0);
  });

  test("cache miss + onWhatsApp throws does not persist (falls back gracefully)", async () => {
    const desk = new LidDesk(tempDir);
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => {
        throw new Error("network error");
      },
    };

    const result = await desk.lookupLidForPhone(
      "5555556666@s.whatsapp.net",
      sock,
    );
    expect(result).toBeNull();
    expect(desk.size).toBe(0);
  });

  test("no socket provided returns null (cache miss, no lookup)", async () => {
    const desk = new LidDesk(tempDir);
    const result = await desk.lookupLidForPhone("5556667777@s.whatsapp.net");
    expect(result).toBeNull();
    expect(desk.size).toBe(0);
  });

  test("no onWhatsApp method on socket returns null", async () => {
    const desk = new LidDesk(tempDir);
    const result = await desk.lookupLidForPhone(
      "5557778888@s.whatsapp.net",
      {},
    );
    expect(result).toBeNull();
  });

  test("onWhatsApp returns exists:true but no lid does not persist", async () => {
    const desk = new LidDesk(tempDir);
    const sock = makeMockSocket({
      "5558889999@s.whatsapp.net": {
        exists: true,
        jid: "5558889999@s.whatsapp.net",
      },
    });

    const result = await desk.lookupLidForPhone(
      "5558889999@s.whatsapp.net",
      sock,
    );
    expect(result).toBeNull();
    expect(desk.size).toBe(0);
  });
});

// ── Rate-limit tests ────────────────────────────────────────────────

describe("LidDesk — lookupLidForPhone rate-limit", () => {
  test("prevents more than N lookups per minute per phone", async () => {
    const desk = new LidDesk(tempDir, { onWhatsAppMaxPerMinute: 3 });
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => [{ exists: false }],
    };

    // First 3 calls should go through (return null, no mapping)
    for (let i = 0; i < 3; i++) {
      const result = await desk.lookupLidForPhone(
        "1111111111@s.whatsapp.net",
        sock,
      );
      expect(result).toBeNull();
    }

    // 4th call should be rate-limited
    const result = await desk.lookupLidForPhone(
      "1111111111@s.whatsapp.net",
      sock,
    );
    expect(result).toBeNull();
    // No mapping should have been persisted (all returned exists:false)
    expect(desk.size).toBe(0);
  });

  test("rate-limit is per-phone — different phones are not affected", async () => {
    const desk = new LidDesk(tempDir, { onWhatsAppMaxPerMinute: 2 });
    let callCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async (_phone) => {
        callCount++;
        // Return exists:false so mappings are NOT cached — each call hits onWhatsApp
        return [{ exists: false }];
      },
    };

    // 2 calls for phone A — both go through (no caching since exists:false)
    await desk.lookupLidForPhone("1111111111@s.whatsapp.net", sock);
    await desk.lookupLidForPhone("1111111111@s.whatsapp.net", sock);

    // 3rd call for phone A — rate limited
    await desk.lookupLidForPhone("1111111111@s.whatsapp.net", sock);

    // 2 calls for phone B — should still go through (different phone)
    await desk.lookupLidForPhone("2222222222@s.whatsapp.net", sock);
    await desk.lookupLidForPhone("2222222222@s.whatsapp.net", sock);

    // 3rd call for phone B — rate limited
    await desk.lookupLidForPhone("2222222222@s.whatsapp.net", sock);

    // 4 onWhatsApp calls total (2 for A + 2 for B; 3rd for each was rate-limited)
    expect(callCount).toBe(4);
  });

  test("cache hit does not count toward rate-limit", async () => {
    const desk = new LidDesk(tempDir, { onWhatsAppMaxPerMinute: 1 });
    desk.record("cached@lid", "3333333333@s.whatsapp.net");

    let callCount = 0;
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => {
        callCount++;
        return [{ exists: true, lid: "other@lid" }];
      },
    };

    // First call — cache hit, should not call onWhatsApp
    const result1 = await desk.lookupLidForPhone(
      "3333333333@s.whatsapp.net",
      sock,
    );
    expect(result1).toBe("cached@lid");
    expect(callCount).toBe(0);

    // Second call — still cache hit, still no call
    const result2 = await desk.lookupLidForPhone(
      "3333333333@s.whatsapp.net",
      sock,
    );
    expect(result2).toBe("cached@lid");
    expect(callCount).toBe(0);
  });
});

// ── resolveSendJid + lookupLidForPhone integration ──────────────────

describe("LidDesk — resolveSendJid with lookupLidForPhone", () => {
  test("resolveSendJid succeeds on phone chatId when desk finds a LID via onWhatsApp", async () => {
    const desk = new LidDesk(tempDir);
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => [
        {
          exists: true,
          jid: "584149145006@s.whatsapp.net",
          lid: "42424242@lid",
        },
      ],
    };

    // Phone chatId — not a LID, resolveSendJid passes through.
    // But we can look up the LID for presence.
    const lid = await desk.lookupLidForPhone(
      "584149145006@s.whatsapp.net",
      sock,
    );
    expect(lid).toBe("42424242@lid");

    // Now the desk has the mapping. resolveSendJid can resolve the LID→phone.
    const lidToJid = desk.getLidToJidMap();
    const phoneJid = resolveSendJid({
      chatId: "42424242@lid",
      selfPhoneJid: null,
      selfLid: null,
      lidToJid,
    });
    expect(phoneJid).toBe("584149145006@s.whatsapp.net");
  });
});
