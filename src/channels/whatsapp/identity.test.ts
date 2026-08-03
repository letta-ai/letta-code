import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveInboundIdentity } from "@/channels/whatsapp/identity";
import {
  WHATSAPP_GROUP_SUFFIX,
  WHATSAPP_LID_SUFFIX,
  WHATSAPP_PHONE_SUFFIX,
} from "@/channels/whatsapp/jid";
import { createLidStore } from "@/channels/whatsapp/lid-store";

const P = WHATSAPP_PHONE_SUFFIX;
const L = WHATSAPP_LID_SUFFIX;
const G = WHATSAPP_GROUP_SUFFIX;
const lid = (n: string) => `${n}${L}`;
const phone = (n: string) => `${n}${P}`;
const group = (n: string) => `${n}${G}`;
const SELF_PHONE = phone("58412000000");
const SELF_LID = lid("999000999");
const GRP = group("120363");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "identity-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// -- invalid input table --

const INVALID_INPUTS: Array<
  [label: string, transport: Record<string, unknown>]
> = [
  [
    "malformed senderPn",
    {
      selfPhoneJid: SELF_PHONE,
      remoteJid: lid("56565656"),
      senderPn: `garbage${P}`,
    },
  ],
  [
    "bare-digit senderPn",
    {
      selfPhoneJid: SELF_PHONE,
      remoteJid: lid("26262626"),
      senderPn: "58412222222",
    },
  ],
  [
    "malformed phone remoteJid",
    { selfPhoneJid: SELF_PHONE, remoteJid: `garbage${P}` },
  ],
  [
    "bare-digit participantPn",
    {
      selfPhoneJid: SELF_PHONE,
      remoteJid: GRP,
      participant: lid("37373737"),
      participantPn: "58412555555",
    },
  ],
  [
    "malformed participantPn",
    {
      selfPhoneJid: SELF_PHONE,
      remoteJid: GRP,
      participant: lid("13579024"),
      participantPn: `garbage${P}`,
    },
  ],
  [
    "malformed selfPhoneJid self-chat",
    { selfPhoneJid: `garbage${P}`, remoteJid: `garbage${P}` },
  ],
  [
    "malformed LID selfLid match",
    {
      selfPhoneJid: SELF_PHONE,
      selfLid: `garbage${L}`,
      remoteJid: `garbage${L}`,
    },
  ],
  [
    "malformed LID remoteJid vs valid selfLid",
    { selfPhoneJid: SELF_PHONE, selfLid: SELF_LID, remoteJid: `garbage${L}` },
  ],
  ["null selfPhoneJid", { selfPhoneJid: null, remoteJid: lid("99998888") }],
  ["omitted selfPhoneJid", { remoteJid: lid("99998889") }],
];

describe("resolveInboundIdentity — invalid inputs", () => {
  for (const [label, transport] of INVALID_INPUTS) {
    test(`${label} => null`, () => {
      expect(resolveInboundIdentity(transport as never, null)).toBeNull();
    });
  }
});

// -- direct --

describe("resolveInboundIdentity — direct", () => {
  test("phone DM: canonical + observedMappings []", () => {
    const r = resolveInboundIdentity({
      selfPhoneJid: SELF_PHONE,
      remoteJid: phone("58412111111"),
    });
    expect(r?.chatId).toBe(phone("58412111111"));
    expect(r?.senderId).toBe("58412111111");
    expect(r?.observedMappings).toEqual([]);
  });

  test("self-chat phone: observedMappings []", () => {
    const r = resolveInboundIdentity({
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
      remoteJid: SELF_PHONE,
    });
    expect(r?.chatId).toBe(SELF_PHONE);
    expect(r?.senderId).toBe("58412000000");
    expect(r?.observedMappings).toEqual([]);
  });

  test("self-chat LID: observedMappings []", () => {
    const r = resolveInboundIdentity({
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
      remoteJid: SELF_LID,
    });
    expect(r?.chatId).toBe(SELF_PHONE);
    expect(r?.observedMappings).toEqual([]);
  });

  test("LID DM first-seen senderPn: resolves + one observation", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("12345678");
    const pn = phone("58412222222");
    const r = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: lj,
        senderPn: pn,
        senderLid: lj,
      },
      store,
    );
    expect(r?.chatId).toBe(pn);
    expect(r?.senderId).toBe("58412222222");
    expect(r?.observedMappings).toEqual([{ lidJid: lj, phoneJid: pn }]);
    // Resolver is pure — store NOT mutated.
    expect(store.resolve(lj)).toBeNull();
  });

  test("PN-form DM with senderLid learns mapping for later hint-less LID DM", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("12344321");
    const pn = phone("58412222223");

    const first = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: pn,
        senderPn: pn,
        senderLid: lj,
      },
      store,
    );
    expect(first?.chatId).toBe(pn);
    expect(first?.senderId).toBe("58412222223");
    expect(first?.observedMappings).toEqual([{ lidJid: lj, phoneJid: pn }]);
    expect(store.resolve(lj)).toBeNull();

    store.record(lj, pn);
    const later = resolveInboundIdentity(
      { selfPhoneJid: SELF_PHONE, remoteJid: lj },
      store,
    );
    expect(later?.chatId).toBe(pn);
    expect(later?.senderId).toBe("58412222223");
    expect(later?.observedMappings).toEqual([]);
  });

  test("conflicting direct PN candidates reject without persistence", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("24681357");
    const r = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: phone("58412222225"),
        senderPn: phone("58412222226"),
        senderLid: lj,
      },
      store,
    );
    expect(r).toBeNull();
    expect(store.resolve(lj)).toBeNull();
  });

  test("invalid optional hints cannot become canonical identities or mappings", () => {
    const store = createLidStore(join(dir, "s.json"));
    const pn = phone("58412222227");
    const r = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: pn,
        senderPn: `not-a-phone${P}`,
        senderLid: `not-a-lid${L}`,
      },
      store,
    );
    expect(r?.chatId).toBe(pn);
    expect(r?.senderId).toBe("58412222227");
    expect(r?.observedMappings).toEqual([]);
    expect(store.resolve(`not-a-lid${L}`)).toBeNull();
  });

  test("LID DM existing matching mapping: resolves, no observation", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("87654321");
    const pn = phone("58412333333");
    store.record(lj, pn);
    const r = resolveInboundIdentity(
      { selfPhoneJid: SELF_PHONE, remoteJid: lj, senderPn: pn },
      store,
    );
    expect(r?.chatId).toBe(pn);
    expect(r?.observedMappings).toEqual([]);
  });

  test("LID DM existing conflicting mapping: null", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("14141414");
    store.record(lj, phone("58415000001"));
    const r = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: lj,
        senderPn: phone("58415000002"),
      },
      store,
    );
    expect(r).toBeNull();
    expect(store.resolve(lj)).toBe(phone("58415000001"));
  });

  test("LID DM unresolved: null", () => {
    const store = createLidStore(join(dir, "s.json"));
    expect(
      resolveInboundIdentity(
        { selfPhoneJid: SELF_PHONE, remoteJid: lid("00000000") },
        store,
      ),
    ).toBeNull();
  });

  test("LID DM unresolved no store: null", () => {
    expect(
      resolveInboundIdentity(
        { selfPhoneJid: SELF_PHONE, remoteJid: lid("77553311") },
        null,
      ),
    ).toBeNull();
  });
});

// -- groups --

describe("resolveInboundIdentity — groups", () => {
  test("phone participant: resolved directly, observedMappings []", () => {
    const r = resolveInboundIdentity({
      selfPhoneJid: SELF_PHONE,
      remoteJid: GRP,
      participant: phone("58412444444"),
    });
    expect(r?.chatId).toBe(GRP);
    expect(r?.senderId).toBe("58412444444");
    expect(r?.observedMappings).toEqual([]);
  });

  test("LID participant + participantPn: resolves + one observation", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("44556677");
    const pn = phone("58412555555");
    const r = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: GRP,
        participant: lj,
        participantPn: pn,
      },
      store,
    );
    expect(r?.senderId).toBe("58412555555");
    expect(r?.observedMappings).toEqual([{ lidJid: lj, phoneJid: pn }]);
    expect(store.resolve(lj)).toBeNull();
  });

  test("participantLid + participantPn (no participant): resolves + one observation", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("88990011");
    const pn = phone("58412666666");
    const r = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: GRP,
        participantPn: pn,
        participantLid: lj,
      },
      store,
    );
    expect(r?.senderId).toBe("58412666666");
    expect(r?.observedMappings).toEqual([{ lidJid: lj, phoneJid: pn }]);
  });

  test("PN-form group participant with participantLid learns later LID-only sender", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("88990022");
    const pn = phone("58412666667");
    const first = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: GRP,
        participant: pn,
        participantLid: lj,
      },
      store,
    );
    expect(first?.chatId).toBe(GRP);
    expect(first?.senderId).toBe("58412666667");
    expect(first?.observedMappings).toEqual([{ lidJid: lj, phoneJid: pn }]);
    expect(store.resolve(lj)).toBeNull();

    store.record(lj, pn);
    const later = resolveInboundIdentity(
      { selfPhoneJid: SELF_PHONE, remoteJid: GRP, participant: lj },
      store,
    );
    expect(later?.senderId).toBe("58412666667");
    expect(later?.observedMappings).toEqual([]);
  });

  test("LID participant in store: resolves, observedMappings []", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("22334455");
    const pj = phone("58412777777");
    store.record(lj, pj);
    const r = resolveInboundIdentity(
      { selfPhoneJid: SELF_PHONE, remoteJid: GRP, participant: lj },
      store,
    );
    expect(r?.senderId).toBe("58412777777");
    expect(r?.observedMappings).toEqual([]);
  });

  test("participantLid-only store resolution: observedMappings []", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("66006600");
    const pj = phone("58416000001");
    store.record(lj, pj);
    const r = resolveInboundIdentity(
      { selfPhoneJid: SELF_PHONE, remoteJid: GRP, participantLid: lj },
      store,
    );
    expect(r?.senderId).toBe("58416000001");
    expect(r?.observedMappings).toEqual([]);
  });

  test("unresolved group LID participant: null", () => {
    expect(
      resolveInboundIdentity({
        selfPhoneJid: SELF_PHONE,
        remoteJid: GRP,
        participant: lid("00000001"),
      }),
    ).toBeNull();
  });

  test("group conflict: stored LID disagrees with participantPn → null", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("99887766");
    store.record(lj, phone("58418000001"));
    const r = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: GRP,
        participant: lj,
        participantPn: phone("58418000002"),
      },
      store,
    );
    expect(r).toBeNull();
    expect(store.resolve(lj)).toBe(phone("58418000001"));
  });

  test("same LID with conflicting participantPn + senderPn → null (store)", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("44556600");
    const r = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: GRP,
        participant: lj,
        participantPn: phone("58419000001"),
        senderPn: phone("58419000002"),
      },
      store,
    );
    expect(r).toBeNull();
    expect(store.resolve(lj)).toBeNull();
  });

  test("no-store: same LID conflicting PNs → null", () => {
    const r = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: GRP,
        participant: lid("44556601"),
        participantPn: phone("58419000003"),
        senderPn: phone("58419000004"),
      },
      null,
    );
    expect(r).toBeNull();
  });

  test("first new + second conflicts with existing store → null", () => {
    const store = createLidStore(join(dir, "s.json"));
    const exLid = lid("55667701");
    store.record(exLid, phone("58419000010"));
    const newLid = lid("55667702");
    const newPhone = phone("58419000011");
    // exLid + participantPn=newPhone (conflicts) ; newLid also paired
    const r = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: GRP,
        participant: exLid,
        participantPn: newPhone,
        participantLid: newLid,
      },
      store,
    );
    expect(r).toBeNull();
    expect(store.resolve(exLid)).toBe(phone("58419000010"));
    expect(store.resolve(newLid)).toBeNull();
  });

  test("duplicate identical observations → idempotent + normal resolution", () => {
    const store = createLidStore(join(dir, "s.json"));
    const lj = lid("66778800");
    const pn = phone("58419000020");
    // participant=LID, participantPn=PN, senderPn=PN — deduped to one observation
    const r = resolveInboundIdentity(
      {
        selfPhoneJid: SELF_PHONE,
        remoteJid: GRP,
        participant: lj,
        participantPn: pn,
        senderPn: pn,
      },
      store,
    );
    expect(r?.chatId).toBe(GRP);
    expect(r?.senderId).toBe("58419000020");
    expect(r?.observedMappings).toEqual([{ lidJid: lj, phoneJid: pn }]);
  });
});
