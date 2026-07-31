import { describe, expect, test } from "bun:test";
import type { InboundChannelMessage } from "@/channels/types";
import {
  createWhatsAppInboundDebounceController,
  type WhatsAppInboundDebounceEntry,
} from "./inbound-debounce";

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function inbound(
  id: string,
  overrides: Partial<InboundChannelMessage> = {},
): InboundChannelMessage {
  return {
    channel: "whatsapp",
    accountId: "account",
    chatId: "120363@g.us",
    senderId: "15550000001",
    text: id,
    timestamp: 1,
    messageId: id,
    raw: { id },
    ...overrides,
  };
}

function entry(
  message: InboundChannelMessage,
  owner: object,
  key: string,
  markRead: (keys: string[]) => unknown,
): WhatsAppInboundDebounceEntry<string> {
  return { inbound: message, receipt: { owner, key, markRead } };
}

function controller(
  debounceMs: number,
  deliver: (message: InboundChannelMessage) => unknown,
) {
  return createWhatsAppInboundDebounceController<string>({
    accountId: "account",
    debounceMs,
    getDeliver: () => async (message) => {
      await deliver(message);
    },
  });
}

describe("WhatsApp inbound debounce controller", () => {
  test("disabled mode delivers separately with one bulk receipt", async () => {
    const delivered: string[] = [];
    const receipts: string[][] = [];
    const owner = {};
    const debouncer = controller(0, (message) => delivered.push(message.text));

    await debouncer.dispatch([
      entry(inbound("one"), owner, "one", (keys) => receipts.push(keys)),
      entry(inbound("two"), owner, "two", (keys) => receipts.push(keys)),
    ]);

    expect(delivered).toEqual(["one", "two"]);
    expect(receipts).toEqual([["one", "two"]]);
  });

  test("concurrent disabled batches keep receipt ownership isolated", async () => {
    const receiptsA: string[][] = [];
    const receiptsB: string[][] = [];
    const ownerA = {};
    const ownerB = {};
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const debouncer = controller(0, async (message) => {
      if (message.text === "a") {
        started();
        await blocked;
      }
    });

    const batchA = debouncer.dispatch([
      entry(inbound("a"), ownerA, "a", (keys) => receiptsA.push(keys)),
      entry(inbound("a2"), ownerA, "a2", (keys) => receiptsA.push(keys)),
    ]);
    await startedPromise;
    await debouncer.dispatch([
      entry(inbound("b"), ownerB, "b", (keys) => receiptsB.push(keys)),
    ]);
    expect(receiptsA).toEqual([]);
    expect(receiptsB).toEqual([["b"]]);
    release();
    await batchA;
    expect(receiptsA).toEqual([["a", "a2"]]);
    expect(receiptsB).toEqual([["b"]]);
  });

  test("enabled text waits, merges, and groups receipt keys", async () => {
    const delivered: InboundChannelMessage[] = [];
    const receipts: string[][] = [];
    const owner = {};
    const debouncer = controller(15, (message) => delivered.push(message));

    await debouncer.dispatch([
      entry(inbound(" first "), owner, "one", (keys) => receipts.push(keys)),
      entry(
        inbound(" second ", { senderName: "latest", timestamp: 2 }),
        owner,
        "two",
        (keys) => receipts.push(keys),
      ),
    ]);
    expect(delivered).toHaveLength(0);
    expect(receipts).toHaveLength(0);
    await wait(25);

    expect(delivered[0]).toMatchObject({
      text: "first\nsecond",
      senderName: "latest",
      timestamp: 2,
      raw: [{ id: " first " }, { id: " second " }],
    });
    expect(receipts).toEqual([["one", "two"]]);
  });

  test("bypasses attachments and reactions while preserving order", async () => {
    const delivered: string[] = [];
    const debouncer = controller(15, (message) => delivered.push(message.text));

    await debouncer.dispatch([
      entry(inbound("text"), {}, "text", () => undefined),
      entry(
        inbound("attachment", { attachments: [{ kind: "file" }] }),
        {},
        "attachment",
        () => undefined,
      ),
      entry(
        inbound("reaction", {
          reaction: {
            action: "added",
            emoji: "👍",
            targetMessageId: "target",
          },
        }),
        {},
        "reaction",
        () => undefined,
      ),
    ]);
    expect(delivered).toEqual(["text", "attachment", "reaction"]);
  });

  test("separates senders into independent debounce keys", async () => {
    const delivered: InboundChannelMessage[] = [];
    const receipts: string[][] = [];
    const owner = {};
    const debouncer = controller(10, (message) => delivered.push(message));

    await debouncer.dispatch([
      entry(inbound("old"), owner, "old", (keys) => receipts.push(keys)),
      entry(inbound("new", { senderId: "other" }), owner, "new", (keys) =>
        receipts.push(keys),
      ),
    ]);
    await wait(20);
    expect(delivered).toHaveLength(2);
    expect(receipts).toEqual([["old"], ["new"]]);
  });

  test("merges same sender across reconnect owners and preserves receipts", async () => {
    const delivered: InboundChannelMessage[] = [];
    const receipts: Array<{ owner: object; keys: string[] }> = [];
    const oldOwner = {};
    const newOwner = {};
    const debouncer = controller(10, (message) => delivered.push(message));

    await debouncer.dispatch([
      entry(inbound("old"), oldOwner, "old", (keys) =>
        receipts.push({ owner: oldOwner, keys }),
      ),
      entry(inbound("new"), newOwner, "new", (keys) =>
        receipts.push({ owner: newOwner, keys }),
      ),
    ]);
    await wait(20);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toBe("old\nnew");
    expect(receipts).toEqual([
      { owner: oldOwner, keys: ["old"] },
      { owner: newOwner, keys: ["new"] },
    ]);
  });

  test("contains delivery and receipt failures", async () => {
    const receipts: string[][] = [];
    const errors: unknown[] = [];
    const debouncer = createWhatsAppInboundDebounceController<string>({
      accountId: "account",
      debounceMs: 5,
      getDeliver: () => async () => {
        throw new Error("delivery failed");
      },
      onDeliveryError: (error) => errors.push(error),
      onReceiptError: (error) => errors.push(error),
    });

    await debouncer.dispatch([
      entry(inbound("failure"), {}, "failure", (keys) => {
        receipts.push(keys);
        return Promise.reject(new Error("receipt failed"));
      }),
    ]);
    await wait(15);
    expect(receipts).toEqual([["failure"]]);
    expect(errors).toHaveLength(2);
  });

  test("absent handler still marks read", async () => {
    const receipts: string[][] = [];
    const debouncer = createWhatsAppInboundDebounceController<string>({
      accountId: "account",
      debounceMs: 10,
      getDeliver: () => undefined,
    });
    await debouncer.dispatch([
      entry(inbound("no-handler"), {}, "key", (keys) => receipts.push(keys)),
    ]);
    await wait(20);
    expect(receipts).toEqual([["key"]]);
  });

  test("receipt starts before a never-resolving delivery settles", async () => {
    const receipts: string[][] = [];
    let delivered = false;
    const debouncer = controller(5, async () => {
      delivered = true;
      await new Promise<void>(() => undefined);
    });
    await debouncer.dispatch([
      entry(inbound("pending"), {}, "key", (keys) => receipts.push(keys)),
    ]);
    await wait(15);
    expect(delivered).toBe(true);
    expect(receipts).toEqual([["key"]]);
  });

  test("flushAll drains all pending keys", async () => {
    const delivered: string[] = [];
    const debouncer = controller(1000, (message) =>
      delivered.push(message.text),
    );
    await debouncer.dispatch([
      entry(inbound("one"), {}, "one", () => undefined),
      entry(inbound("two", { senderId: "other" }), {}, "two", () => undefined),
    ]);
    await debouncer.flushAll();
    expect(delivered).toEqual(["one", "two"]);
  });
});
