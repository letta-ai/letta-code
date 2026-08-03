import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InboundChannelMessage,
  WhatsAppChannelAccount,
} from "@/channels/types";
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

const account: WhatsAppChannelAccount = {
  channel: "whatsapp",
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
  return makeTextMessage(remoteJid, id, "hello", key);
}

function makeTextMessage(
  remoteJid: string,
  id: string,
  text: string,
  key: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: { remoteJid, id, ...key },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  accountOverrides: Partial<WhatsAppChannelAccount> = {},
) {
  let upsertHandler: ((payload: unknown) => unknown) | undefined;
  const sentJids: string[] = [];
  const sentPayloads: Array<Record<string, unknown>> = [];
  const sentOptions: Array<Record<string, unknown> | undefined> = [];
  const presenceUpdates: Array<{ presence: string; jid?: string }> = [];
  const socket = {
    ev: {
      on(event: string, handler: (payload: unknown) => void) {
        if (event === "messages.upsert") upsertHandler = handler;
      },
    },
    ws: { close() {} },
    user: { id: phone("15551234567"), lid: lid("777000111") },
    async sendMessage(
      jid: string,
      payload: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) {
      sentJids.push(jid);
      sentPayloads.push(payload);
      sentOptions.push(options);
      return { key: { id: "outbound" } };
    },
    async sendPresenceUpdate(presence: string, jid?: string) {
      presenceUpdates.push({ presence, jid });
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
  const adapter = createWhatsAppAdapter(
    { ...account, ...accountOverrides },
    dependencies,
  );
  adapter.onMessage = onMessage;
  return {
    adapter,
    async emit(messages: Record<string, unknown>[]) {
      await upsertHandler?.({ type: "notify", messages });
    },
    sentJids,
    sentPayloads,
    sentOptions,
    presenceUpdates,
  };
}

type DebounceConnectionUpdateHandler = NonNullable<
  Parameters<
    NonNullable<WhatsAppAdapterDependencies["createSocket"]>
  >[0]["onConnectionUpdate"]
>;

type DebounceHarnessSocket = {
  upsertHandler?: (payload: unknown) => unknown;
  connectionUpdate?: DebounceConnectionUpdateHandler;
  readCalls: string[][];
  closed: number;
};

function makeDebounceHarness(options: {
  store: LidStore;
  accountPatch?: Partial<WhatsAppChannelAccount>;
  onMessage: (message: InboundChannelMessage) => Promise<void>;
  readMessages?: (keys: Record<string, unknown>[]) => Promise<unknown>;
}) {
  const sockets: DebounceHarnessSocket[] = [];
  const testAccount: WhatsAppChannelAccount = {
    ...account,
    accountId: options.accountPatch?.accountId ?? "debounce-test",
    ...options.accountPatch,
  };
  const createSocket: NonNullable<
    WhatsAppAdapterDependencies["createSocket"]
  > = async (runtimeOptions) => {
    const socketRecord: DebounceHarnessSocket = {
      connectionUpdate: runtimeOptions.onConnectionUpdate,
      readCalls: [],
      closed: 0,
    };
    const socket = {
      ev: {
        on(event: string, handler: (payload: unknown) => void) {
          if (event === "messages.upsert") socketRecord.upsertHandler = handler;
        },
      },
      ws: {
        close() {
          socketRecord.closed += 1;
        },
      },
      user: { id: phone("15551234567"), lid: lid("777000111") },
      async readMessages(keys: Record<string, unknown>[]) {
        socketRecord.readCalls.push(keys.map((key) => String(key.id)));
        if (options.readMessages) return options.readMessages(keys);
        return undefined;
      },
      async sendMessage() {
        return { key: { id: "outbound" } };
      },
    };
    sockets.push(socketRecord);
    return {
      sock: socket,
      saveCreds: async () => undefined,
      DisconnectReason: {},
      release: () => undefined,
    };
  };
  const adapter = createWhatsAppAdapter(testAccount, {
    createSocket,
    loadRuntimeModule: async () => ({}),
    lidStore: options.store,
  });
  adapter.onMessage = options.onMessage;
  return {
    adapter,
    sockets,
    async emit(
      messages: Record<string, unknown>[],
      emitOptions?: { socketIndex?: number; type?: "notify" | "append" },
    ) {
      const socketIndex = emitOptions?.socketIndex ?? sockets.length - 1;
      await sockets[socketIndex]?.upsertHandler?.({
        type: emitOptions?.type ?? "notify",
        messages,
      });
    },
    closeConnection(socketIndex = sockets.length - 1) {
      sockets[socketIndex]?.connectionUpdate?.({
        connection: "close",
        lastDisconnect: { error: { message: "network" } },
      });
    },
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

  test("PN-form DM senderLid is passed through and later LID DM resolves", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid-sender.json")));
    const received: InboundChannelMessage[] = [];
    const harness = makeHarness(store, async (message) => {
      received.push(message);
    });
    await harness.adapter.start();

    const pn = phone("15550000018");
    const senderLid = lid("91919191");
    await harness.emit([
      makeMessage(pn, "pn-with-lid", {
        senderLid,
      }),
    ]);
    expect(store.resolve(senderLid)).toBe(pn);

    await harness.emit([makeMessage(senderLid, "lid-without-hints")]);
    expect(received.map((message) => message.chatId)).toEqual([pn, pn]);
    expect(received.map((message) => message.senderId)).toEqual([
      "15550000018",
      "15550000018",
    ]);
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

  test("attachment policy denial happens before presence or network send", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const filePath = join(dir, "deny.txt");
    writeFileSync(filePath, "nope");
    const harness = makeHarness(store, async () => undefined, {
      attachmentFilter: true,
      attachmentAllowedRecipients: [phone("15550000013")],
      attachmentMimeTypes: ["image/png"],
      attachmentAllowedPaths: [dir],
    });
    await harness.adapter.start();

    await expect(
      harness.adapter.sendMessage({
        channel: "whatsapp",
        accountId: account.accountId,
        chatId: phone("15550000013"),
        text: "blocked",
        mediaPath: filePath,
      }),
    ).rejects.toThrow(/MIME type .*text\/plain.* is not allowed/);
    expect(harness.presenceUpdates).toHaveLength(0);
    expect(harness.sentJids).toHaveLength(0);
  });

  test("attachment policy evaluates the resolved phone for stored LID targets", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const known = lid("13131313");
    const mapped = phone("15550000013");
    store.record(known, mapped);
    const filePath = join(dir, "photo.png");
    writeFileSync(filePath, "png");
    const harness = makeHarness(store, async () => undefined, {
      attachmentFilter: true,
      attachmentAllowedRecipients: ["15550000013"],
      attachmentMimeTypes: ["image/png"],
      attachmentAllowedPaths: [dir],
    });
    await harness.adapter.start();

    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: known,
      text: "ok",
      mediaPath: filePath,
    });

    expect(harness.sentJids).toEqual([mapped]);
    expect(harness.sentPayloads[0]).toEqual({
      image: { url: realpathSync(filePath) },
      caption: "ok",
    });
  });

  test("attachment policy preserves exact group JID allowlists", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const filePath = join(dir, "photo.png");
    writeFileSync(filePath, "png");
    const targetGroup = group("120363000000");
    const harness = makeHarness(store, async () => undefined, {
      attachmentFilter: true,
      attachmentAllowedRecipients: [targetGroup],
      attachmentMimeTypes: ["image/png"],
      attachmentAllowedPaths: [dir],
    });
    await harness.adapter.start();

    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: targetGroup,
      text: "group",
      mediaPath: filePath,
    });
    await expect(
      harness.adapter.sendMessage({
        channel: "whatsapp",
        accountId: account.accountId,
        chatId: group("120363000001"),
        text: "group",
        mediaPath: filePath,
      }),
    ).rejects.toThrow(/not allowed/);

    expect(harness.sentJids).toEqual([targetGroup]);
  });

  test("attachment policy passes canonical symlink target and MIME to Baileys", async () => {
    const store = instrumentStore(createLidStore(join(dir, "lid.json")));
    const root = join(dir, "allowed");
    mkdirSync(root);
    const realFile = join(root, "song.mp3");
    const linkPath = join(dir, "song-link.bin");
    writeFileSync(realFile, "audio");
    symlinkSync(realFile, linkPath);
    const harness = makeHarness(store, async () => undefined, {
      attachmentFilter: true,
      attachmentAllowedRecipients: [phone("15550000014")],
      attachmentMimeTypes: ["audio/mpeg"],
      attachmentAllowedPaths: [root],
    });
    await harness.adapter.start();

    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: phone("15550000014"),
      text: "listen",
      mediaPath: linkPath,
      fileName: "fake.bin",
    });

    expect(harness.sentPayloads[0]).toEqual({
      document: { url: realpathSync(realFile) },
      fileName: "song.mp3",
      mimetype: "audio/mpeg",
      caption: "listen",
    });
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

describe("WhatsApp adapter inbound debounce and read receipts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adapter-debounce-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("batches canonical sender/chat text and marks one socket-bound read receipt batch", async () => {
    const received: InboundChannelMessage[] = [];
    const harness = makeDebounceHarness({
      store: createLidStore(join(dir, "lid.json")),
      accountPatch: { inboundDebounceMs: 20, groupMode: "open" },
      onMessage: async (message) => {
        received.push(message);
      },
    });
    await harness.adapter.start();

    await harness.emit([
      makeTextMessage(group("120363"), "one", "first", {
        participant: lid("44445555"),
        participantPn: phone("15550000006"),
      }),
      makeTextMessage(group("120363"), "two", "second", {
        participant: lid("44445555"),
      }),
    ]);

    expect(received).toEqual([]);
    expect(harness.sockets[0]?.readCalls).toEqual([]);
    await sleep(60);
    expect(received).toHaveLength(1);
    expect(harness.sockets[0]?.readCalls).toEqual([["one", "two"]]);
    expect(received[0]?.chatId).toBe(group("120363"));
    expect(received[0]?.senderId).toBe("15550000006");
    expect(received[0]?.text).toBe("first\nsecond");
    expect(Array.isArray(received[0]?.raw)).toBe(true);
  });

  test("keeps unrelated chats and senders independent", async () => {
    const received: InboundChannelMessage[] = [];
    const harness = makeDebounceHarness({
      store: createLidStore(join(dir, "lid.json")),
      accountPatch: { inboundDebounceMs: 20, groupMode: "open" },
      onMessage: async (message) => {
        received.push(message);
      },
    });
    await harness.adapter.start();

    await harness.emit([
      makeTextMessage(group("120363"), "sender-a", "sender a", {
        participant: phone("15550000021"),
      }),
      makeTextMessage(group("120363"), "sender-b", "sender b", {
        participant: phone("15550000022"),
      }),
      makeTextMessage(phone("15550000023"), "direct", "direct"),
    ]);

    await sleep(60);
    expect(received.map((message) => message.text).sort()).toEqual([
      "direct",
      "sender a",
      "sender b",
    ]);
  });

  test("default debounce remains immediate while read receipt ownership is per upsert", async () => {
    const received: InboundChannelMessage[] = [];
    const harness = makeDebounceHarness({
      store: createLidStore(join(dir, "lid.json")),
      onMessage: async (message) => {
        received.push(message);
      },
    });
    await harness.adapter.start();

    await harness.emit([
      makeTextMessage(phone("15550000031"), "one", "one"),
      makeTextMessage(phone("15550000031"), "two", "two"),
    ]);

    expect(received.map((message) => message.text)).toEqual(["one", "two"]);
    expect(harness.sockets[0]?.readCalls).toEqual([["one", "two"]]);
  });

  test("read receipt failures do not block delivery", async () => {
    const received: InboundChannelMessage[] = [];
    const harness = makeDebounceHarness({
      store: createLidStore(join(dir, "lid.json")),
      onMessage: async (message) => {
        received.push(message);
      },
      readMessages: async () => {
        throw new Error("read receipt failed");
      },
    });
    await harness.adapter.start();

    await harness.emit([makeTextMessage(phone("15550000041"), "one", "body")]);

    expect(received.map((message) => message.text)).toEqual(["body"]);
    expect(harness.sockets[0]?.readCalls).toEqual([["one"]]);
  });

  test("does not mark read or deliver dropped group traffic and reactions", async () => {
    const received: InboundChannelMessage[] = [];
    const harness = makeDebounceHarness({
      store: createLidStore(join(dir, "lid.json")),
      accountPatch: { groupMode: "mention" },
      onMessage: async (message) => {
        received.push(message);
      },
    });
    await harness.adapter.start();

    await harness.emit([
      makeTextMessage(group("120363"), "unmentioned", "not for you", {
        participant: phone("15550000051"),
      }),
      {
        key: {
          remoteJid: group("120363"),
          id: "reaction",
          participant: phone("15550000051"),
        },
        message: { reactionMessage: { text: "👍" } },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ]);

    await sleep(20);
    expect(received).toEqual([]);
    expect(harness.sockets[0]?.readCalls).toEqual([]);
  });

  test("stop and restarted socket ownership cancel pending debounce batches", async () => {
    const received: InboundChannelMessage[] = [];
    const harness = makeDebounceHarness({
      store: createLidStore(join(dir, "lid.json")),
      accountPatch: { inboundDebounceMs: 40 },
      onMessage: async (message) => {
        received.push(message);
      },
    });
    await harness.adapter.start();

    await harness.emit([makeTextMessage(phone("15550000061"), "old", "old")]);
    expect(harness.sockets[0]?.readCalls).toEqual([]);
    await harness.adapter.stop();
    await sleep(70);
    expect(received).toEqual([]);
    expect(harness.sockets[0]?.readCalls).toEqual([]);

    await harness.adapter.start();
    await harness.emit(
      [makeTextMessage(phone("15550000062"), "stale", "stale")],
      { socketIndex: 0 },
    );
    await sleep(70);
    expect(received).toEqual([]);
    expect(harness.sockets[0]?.readCalls).toEqual([]);
    expect(harness.sockets[1]?.readCalls).toEqual([]);

    await harness.emit([
      makeTextMessage(phone("15550000061"), "old", "replayed"),
    ]);
    expect(harness.sockets[1]?.readCalls).toEqual([]);
    await sleep(70);
    expect(received.map((message) => message.text)).toEqual(["replayed"]);
    expect(harness.sockets[1]?.readCalls).toEqual([["old"]]);

    await harness.adapter.stop();
    await harness.adapter.start();
    await harness.emit([
      makeTextMessage(phone("15550000061"), "old", "duplicate replay"),
    ]);
    await sleep(70);
    expect(received.map((message) => message.text)).toEqual(["replayed"]);
    expect(harness.sockets[2]?.readCalls).toEqual([]);
  });

  test("connection close invalidates pending debounce and stale socket traffic without reads", async () => {
    const received: InboundChannelMessage[] = [];
    const harness = makeDebounceHarness({
      store: createLidStore(join(dir, "lid.json")),
      accountPatch: { inboundDebounceMs: 40 },
      onMessage: async (message) => {
        received.push(message);
      },
    });
    await harness.adapter.start();

    await harness.emit([makeTextMessage(phone("15550000071"), "old", "old")]);
    expect(harness.sockets[0]?.readCalls).toEqual([]);
    harness.closeConnection(0);
    await sleep(70);
    expect(received).toEqual([]);
    expect(harness.sockets[0]?.readCalls).toEqual([]);

    await harness.emit(
      [makeTextMessage(phone("15550000072"), "stale", "stale")],
      { socketIndex: 0 },
    );
    await sleep(70);
    expect(received).toEqual([]);
    expect(harness.sockets[0]?.readCalls).toEqual([]);
    await harness.adapter.stop();
  });

  test("handler rejection does not mark messages read", async () => {
    const harness = makeDebounceHarness({
      store: createLidStore(join(dir, "lid.json")),
      accountPatch: { inboundDebounceMs: 20 },
      onMessage: async () => {
        throw new Error("handler failed");
      },
    });
    await harness.adapter.start();

    await harness.emit([
      makeTextMessage(phone("15550000081"), "rejected", "rejected"),
    ]);
    await sleep(60);
    expect(harness.sockets[0]?.readCalls).toEqual([]);
  });
});
