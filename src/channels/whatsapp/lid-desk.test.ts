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
import { LidDesk } from "./lid-desk";

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
  test("mines PN from msg.key.senderPn when remoteJid is a LID", () => {
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

  test("mines PN from participant when remoteJid is a LID and senderPn absent", () => {
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

  test("mines PN from senderPn when participant is a LID (group context)", () => {
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
});

describe("LidDesk — mining from socket", () => {
  test("reads signalRepository.lidMapping Map", () => {
    const desk = new LidDesk(tempDir);
    const lidMapping = new Map([
      ["111111@lid", "1111111111@s.whatsapp.net"],
      ["222222@lid", "2222222222@s.whatsapp.net"],
    ]);
    const count = desk.mineFromSocket({
      signalRepository: { lidMapping },
    });
    expect(count).toBe(2);
    expect(desk.resolveLid("111111@lid")).toBe("1111111111@s.whatsapp.net");
    expect(desk.resolveLid("222222@lid")).toBe("2222222222@s.whatsapp.net");
  });

  test("returns 0 when signalRepository is absent", () => {
    const desk = new LidDesk(tempDir);
    expect(desk.mineFromSocket(null)).toBe(0);
    expect(desk.mineFromSocket({})).toBe(0);
    expect(desk.mineFromSocket({ signalRepository: {} })).toBe(0);
  });

  test("skips already-known mappings", () => {
    const desk = new LidDesk(tempDir);
    desk.record("111111@lid", "1111111111@s.whatsapp.net");
    const count = desk.mineFromSocket({
      signalRepository: {
        lidMapping: new Map([
          ["111111@lid", "1111111111@s.whatsapp.net"], // duplicate
          ["222222@lid", "2222222222@s.whatsapp.net"], // new
        ]),
      },
    });
    expect(count).toBe(1);
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
