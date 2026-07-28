import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundChannelMessage } from "@/channels/types";
import {
  createWhatsAppAdapter,
  type WhatsAppAdapterDependencies,
} from "@/channels/whatsapp/adapter";
import {
  WHATSAPP_GROUP_SUFFIX,
  WHATSAPP_LID_SUFFIX,
  WHATSAPP_PHONE_SUFFIX,
} from "@/channels/whatsapp/jid";
import { createLidStore, type LidStore } from "@/channels/whatsapp/lid-store";

const account = {
  channel: "whatsapp" as const,
  accountId: "phase-b-test",
  enabled: true,
  dmPolicy: "pairing" as const,
  allowedUsers: [],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  agentId: "agent-test",
  selfChatMode: false,
  groupMode: "open" as const,
};

const phone = (value: string) => `${value}${WHATSAPP_PHONE_SUFFIX}`;
const lid = (value: string) => `${value}${WHATSAPP_LID_SUFFIX}`;
const group = (value: string) => `${value}${WHATSAPP_GROUP_SUFFIX}`;

function makeMessage(
  remoteJid: string,
  id: string,
  key: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: { remoteJid, id, ...key },
    message: { conversation: "hello" },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

function instrumentStore(store: LidStore): LidStore & { flushes: number } {
  let flushes = 0;
  return {
    get flushes() {
      return flushes;
    },
    resolve: (value) => store.resolve(value),
    record: (key, value) => store.record(key, value),
    flush: () => {
      flushes += 1;
      store.flush();
    },
  };
}

function makeHarness(
  store: LidStore,
  onMessage: (message: InboundChannelMessage) => Promise<void>,
) {
  let upsertHandler: ((payload: unknown) => unknown) | undefined;
  const sentJids: string[] = [];
  const socket = {
    ev: {
      on(event: string, handler: (payload: unknown) => void) {
        if (event === "messages.upsert") upsertHandler = handler;
      },
    },
    ws: { close() {} },
    user: { id: phone("15551234567"), lid: lid("777000111") },
    async sendMessage(jid: string) {
      sentJids.push(jid);
      return { key: { id: "outbound" } };
    },
  };
  const createSocket: NonNullable<
    WhatsAppAdapterDependencies["createSocket"]
  > = async () => ({
    sock: socket,
    saveCreds: async () => undefined,
    DisconnectReason: {},
    release: () => undefined,
  });
  const dependencies: WhatsAppAdapterDependencies = {
    createSocket,
    loadRuntimeModule: async () => ({}),
    lidStore: store,
  };
  const adapter = createWhatsAppAdapter(account, dependencies);
  adapter.onMessage = onMessage;
  return {
    adapter,
    async emit(messages: Record<string, unknown>[]) {
      await upsertHandler?.({ type: "notify", messages });
    },
    sentJids,
  };
}

describe("WhatsApp adapter canonical identity integration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adapter-identity-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("records a LID observation and flushes once per batch", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const received: InboundChannelMessage[] = [];
    const harness = makeHarness(store, async (message) => {
      received.push(message);
    });

    await harness.adapter.start();
    await harness.emit([
      makeMessage(lid("12345678"), "one", {
        senderPn: phone("15550000001"),
      }),
      makeMessage(lid("87654321"), "two", {
        senderPn: phone("15550000002"),
      }),
    ]);

    expect(received.map((message) => message.chatId)).toEqual([
      phone("15550000001"),
      phone("15550000002"),
    ]);
    expect(received.map((message) => message.senderId)).toEqual([
      "15550000001",
      "15550000002",
    ]);
    expect(store.flushes).toBe(1);
    expect(store.resolve(lid("12345678"))).toBe(phone("15550000001"));
    expect(received[0]?.raw).toBeDefined();
  });

  test("later LID DM resolves from the persisted store after restart", async () => {
    const path = join(dir, "lid.json");
    const first = instrumentStore(createLidStore(path));
    const firstHarness = makeHarness(first, async () => undefined);
    await firstHarness.adapter.start();
    await firstHarness.emit([
      makeMessage(lid("22223333"), "first", {
        senderPn: phone("15550000003"),
      }),
    ]);
    await firstHarness.adapter.stop();

    const received: InboundChannelMessage[] = [];
    const second = instrumentStore(createLidStore(path));
    const secondHarness = makeHarness(second, async (message) => {
      received.push(message);
    });
    await secondHarness.adapter.start();
    await secondHarness.emit([makeMessage(lid("22223333"), "second")]);

    expect(received[0]?.chatId).toBe(phone("15550000003"));
    expect(received[0]?.senderId).toBe("15550000003");
  });

  test("unresolved and conflicting direct identities are not delivered", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const existing = lid("33334444");
    store.record(existing, phone("15550000004"));
    const received: InboundChannelMessage[] = [];
    const harness = makeHarness(store, async (message) => {
      received.push(message);
    });
    await harness.adapter.start();

    await harness.emit([
      makeMessage(lid("55556666"), "unknown"),
      makeMessage(existing, "conflict", { senderPn: phone("15550000005") }),
    ]);

    expect(received).toHaveLength(0);
    expect(store.resolve(existing)).toBe(phone("15550000004"));
    expect(store.flushes).toBe(0);
  });

  test("group observations canonicalize sender and support later LID-only messages", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const received: InboundChannelMessage[] = [];
    const harness = makeHarness(store, async (message) => {
      received.push(message);
    });
    await harness.adapter.start();

    await harness.emit([
      makeMessage(group("120363"), "group-one", {
        participant: lid("44445555"),
        participantPn: phone("15550000006"),
      }),
      makeMessage(group("120363"), "group-two", {
        participant: lid("44445555"),
      }),
    ]);

    expect(received.map((message) => message.senderId)).toEqual([
      "15550000006",
      "15550000006",
    ]);
    expect(received[0]?.chatId).toBe(group("120363"));
    expect(store.flushes).toBe(1);
  });

  test("conflicting group evidence is dropped without overwriting", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const existing = lid("66667777");
    store.record(existing, phone("15550000007"));
    const received: InboundChannelMessage[] = [];
    const harness = makeHarness(store, async (message) => {
      received.push(message);
    });
    await harness.adapter.start();

    await harness.emit([
      makeMessage(group("120363"), "group-conflict", {
        participant: existing,
        participantPn: phone("15550000008"),
      }),
    ]);

    expect(received).toHaveLength(0);
    expect(store.resolve(existing)).toBe(phone("15550000007"));
  });

  test("canonical LID and PN forms share a dedupe key", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const received: InboundChannelMessage[] = [];
    const harness = makeHarness(store, async (message) => {
      received.push(message);
    });
    await harness.adapter.start();

    await harness.emit([
      makeMessage(lid("88889999"), "same", {
        senderPn: phone("15550000009"),
      }),
      makeMessage(phone("15550000009"), "same"),
    ]);

    expect(received).toHaveLength(1);
    expect(store.flushes).toBe(1);
  });

  test("PN-first canonical dedupe still learns the later LID mapping", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const received: InboundChannelMessage[] = [];
    const legacy = lid("90909090");
    const mapped = phone("15550000013");
    const harness = makeHarness(store, async (message) => {
      received.push(message);
    });
    await harness.adapter.start();

    await harness.emit([
      makeMessage(mapped, "same-reverse"),
      makeMessage(legacy, "same-reverse", { senderPn: mapped }),
    ]);

    expect(received).toHaveLength(1);
    expect(received[0]?.chatId).toBe(mapped);
    expect(store.resolve(legacy)).toBe(mapped);
    expect(store.flushes).toBe(1);
  });

  test("outbound send resolves known LID and rejects unknown LID", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const known = lid("12121212");
    const mapped = phone("15550000012");
    store.record(known, mapped);
    const harness = makeHarness(store, async () => undefined);
    await harness.adapter.start();

    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: known,
      text: "outbound",
    });
    expect(harness.sentJids).toEqual([mapped]);

    await expect(
      harness.adapter.sendMessage({
        channel: "whatsapp",
        accountId: account.accountId,
        chatId: lid("34343434"),
        text: "unknown",
      }),
    ).rejects.toThrow(/unresolved/i);
    expect(harness.sentJids).toEqual([mapped]);

    await harness.adapter.sendDirectReply(known, "reply");
    expect(harness.sentJids).toEqual([mapped, mapped]);
  });

  test("handler failure still flushes dirty observations", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const harness = makeHarness(store, async () => {
      throw new Error("handler failed");
    });
    await harness.adapter.start();

    await harness.emit([
      makeMessage(lid("99990000"), "failure", {
        senderPn: phone("15550000010"),
      }),
    ]);

    expect(store.flushes).toBe(1);
    expect(store.resolve(lid("99990000"))).toBe(phone("15550000010"));
  });

  test("flush failure stays dirty and retries on the next batch", async () => {
    const base = createLidStore(join(dir, "retry.json"));
    let attempts = 0;
    const store: LidStore = {
      resolve: (value) => base.resolve(value),
      record: (key, value) => base.record(key, value),
      flush: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk unavailable");
        base.flush();
      },
    };
    const harness = makeHarness(store, async () => undefined);
    await harness.adapter.start();

    await harness.emit([
      makeMessage(lid("11110000"), "retry", {
        senderPn: phone("15550000011"),
      }),
    ]);
    expect(attempts).toBe(1);

    await harness.emit([makeMessage(phone("15550000011"), "retry-second")]);
    expect(attempts).toBe(2);

    await harness.adapter.stop();
    expect(attempts).toBe(2);
    expect(
      createLidStore(join(dir, "retry.json")).resolve(lid("11110000")),
    ).toBe(phone("15550000011"));
  });
});
