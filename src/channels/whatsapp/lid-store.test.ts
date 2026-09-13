import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WHATSAPP_GROUP_SUFFIX,
  WHATSAPP_LID_SUFFIX,
  WHATSAPP_PHONE_SUFFIX,
} from "@/channels/whatsapp/jid";
import { createLidStore } from "@/channels/whatsapp/lid-store";

const L = WHATSAPP_LID_SUFFIX;
const P = WHATSAPP_PHONE_SUFFIX;
const G = WHATSAPP_GROUP_SUFFIX;
const lid = (n: string) => `${n}${L}`;
const phone = (n: string) => `${n}${P}`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lid-store-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const STORE_INVALID_INPUTS: Array<
  [label: string, key: unknown, value: unknown]
> = [
  ["phone JID as key", phone("58414444444"), phone("58414111111")],
  ["random string key", "not-a-jid", phone("58414111111")],
  ["empty key", "", phone("58414111111")],
  ["LID as value", lid("111222333"), lid("999888777")],
  ["garbage value", lid("111222333"), "garbage"],
  ["empty value", lid("111222333"), ""],
  ["bare digits value", lid("16161616"), "58414111111"],
  ["garbage localpart key", `garbage${L}`, phone("58414111111")],
  ["group JID as key", `123${G}`, phone("58414111111")],
  ["garbage localpart value", lid("222333444"), `garbage${P}`],
  ["group JID as value", lid("222333444"), `123${G}`],
];

describe("lid-store", () => {
  test("round-trip: record → resolve", () => {
    const store = createLidStore(join(dir, "s.json"));
    expect(store.record(lid("123456789"), phone("58414111111"))).toEqual({
      status: "recorded",
    });
    expect(store.resolve(lid("123456789"))).toBe(phone("58414111111"));
  });

  test("device suffix normalization (key + value)", () => {
    const store = createLidStore(join(dir, "s.json"));
    store.record("123456789:5@lid", "58414222222:3@s.whatsapp.net");
    expect(store.resolve("123456789@lid")).toBe(phone("58414222222"));
    expect(store.resolve("123456789:7@lid")).toBe(phone("58414222222"));
  });

  test("invalid inputs rejected", () => {
    const store = createLidStore(join(dir, "s.json"));
    for (const [label, key, value] of STORE_INVALID_INPUTS) {
      expect(store.record(key as string, value as string), label).toBeNull();
    }
  });

  test("idempotent: same mapping twice", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("555666777");
    const pj = phone("58414555555");
    expect(store.record(lj, pj)).toEqual({ status: "recorded" });
    expect(store.record(lj, pj)).toEqual({ status: "idempotent" });
  });

  test("conflict: old mapping preserved", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("333444555");
    store.record(lj, phone("58414666666"));
    expect(store.record(lj, phone("58414777777"))).toEqual({
      status: "conflict",
      existingPhoneJid: phone("58414666666"),
      requestedPhoneJid: phone("58414777777"),
    });
    expect(store.resolve(lj)).toBe(phone("58414666666"));
  });

  test("multiple LIDs → same phone", () => {
    const store = createLidStore(join(dir, "s.json"));
    const shared = phone("58414888888");
    store.record(lid("100100100"), shared);
    store.record(lid("200200200"), shared);
    expect(store.resolve(lid("100100100"))).toBe(shared);
    expect(store.resolve(lid("200200200"))).toBe(shared);
  });

  test("corrupt JSON safe startup", () => {
    const fp = join(dir, "corrupt.json");
    writeFileSync(fp, "{ invalid json :::", "utf8");
    const store = createLidStore(fp);
    store.record(lid("123"), phone("58414999999"));
    expect(store.resolve(lid("123"))).toBe(phone("58414999999"));
  });

  test("invalid persisted entries ignored on load", () => {
    const fp = join(dir, "mixed.json");
    const vl = lid("777888999");
    const vp = phone("58414000001");
    writeFileSync(
      fp,
      JSON.stringify({
        entries: [
          { lid: vl, phone: vp },
          { lid: phone("58414000002"), phone: vp },
          { lid: vl, phone: lid("111222333") },
          { lid: "not-a-jid", phone: vp },
          { lid: lid("444555666"), phone: "garbage" },
        ],
      }),
      "utf8",
    );
    const store = createLidStore(fp);
    expect(store.resolve(vl)).toBe(vp);
    expect(store.resolve(lid("444555666"))).toBeNull();
  });

  test("legacy object-map format not parsed", () => {
    const fp = join(dir, "legacy.json");
    const vl = lid("888999000");
    writeFileSync(fp, JSON.stringify({ [vl]: phone("58414000020") }), "utf8");
    expect(createLidStore(fp).resolve(vl)).toBeNull();
  });

  test("duplicate LID with conflicting phones omitted on load", () => {
    const fp = join(dir, "cd.json");
    const dl = lid("666777888");
    const kl = lid("111222333");
    writeFileSync(
      fp,
      JSON.stringify({
        entries: [
          { lid: dl, phone: phone("58414000030") },
          { lid: kl, phone: phone("58414000032") },
          { lid: dl, phone: phone("58414000031") },
        ],
      }),
      "utf8",
    );
    const store = createLidStore(fp);
    expect(store.resolve(dl)).toBeNull();
    expect(store.resolve(kl)).toBe(phone("58414000032"));
  });

  test("duplicate identical entries keep one mapping on load", () => {
    const fp = join(dir, "id.json");
    const dl = lid("555666777");
    const pj = phone("58414000040");
    writeFileSync(
      fp,
      JSON.stringify({
        entries: [
          { lid: dl, phone: pj },
          { lid: dl, phone: pj },
        ],
      }),
      "utf8",
    );
    expect(createLidStore(fp).resolve(dl)).toBe(pj);
  });

  test("atomic flush writes valid JSON + reloads", () => {
    const fp = join(dir, "atomic.json");
    const store = createLidStore(fp);
    store.record(lid("121212121"), phone("58414000003"));
    store.record(lid("343434343"), phone("58414000004"));
    store.flush();

    expect(existsSync(fp)).toBe(true);
    expect(JSON.parse(readFileSync(fp, "utf8")).entries).toHaveLength(2);

    const reloaded = createLidStore(fp);
    expect(reloaded.resolve(lid("121212121"))).toBe(phone("58414000003"));
    expect(reloaded.resolve(lid("343434343"))).toBe(phone("58414000004"));
  });

  test("flush leaves no temp files", () => {
    const fp = join(dir, "clean.json");
    createLidStore(fp).flush();
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("clean.json");
  });

  test("relative path rejected", () => {
    expect(() => createLidStore("relative/path.json")).toThrow("absolute path");
  });
});
