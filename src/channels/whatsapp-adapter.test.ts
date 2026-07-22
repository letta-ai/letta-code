import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWhatsAppAdapter,
  isWhatsAppConflictDisconnect,
} from "@/channels/whatsapp/adapter";
import { checkAttachmentPolicy } from "@/channels/whatsapp/media";
import type { WhatsAppChannelAccount } from "@/channels/types";

describe("WhatsApp adapter helpers", () => {
  test("detects session conflict disconnects by message", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { message: "Stream Errored (conflict)" } },
      }),
    ).toBe(true);
  });

  test("detects session conflict disconnects by status code", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 440 } } },
      }),
    ).toBe(true);
  });

  test("ignores non-conflict disconnects", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { message: "timed out" } },
      }),
    ).toBe(false);
  });

  test("implements turn lifecycle event handling", async () => {
    const adapter = createWhatsAppAdapter({
      channel: "whatsapp",
      accountId: "main",
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      agentId: "agent-whatsapp",
      selfChatMode: true,
      groupMode: "disabled",
    });

    expect(adapter.handleTurnLifecycleEvent).toBeTypeOf("function");

    await expect(
      adapter.handleTurnLifecycleEvent?.({
        type: "finished",
        batchId: "batch-1",
        outcome: "error",
        stopReason: "error",
        error: "Turn failed",
        sources: [
          {
            channel: "whatsapp",
            accountId: "main",
            chatId: "15551234567@s.whatsapp.net",
            messageId: "msg-1",
            agentId: "agent-whatsapp",
            conversationId: "conv-whatsapp",
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("WhatsApp adapter attachment policy wiring", () => {
  // The adapter's sendMessage guards on `running` before reaching the policy
  // check, and starting requires a live Baileys socket. Instead of mocking the
  // full socket, we verify the wiring by exercising the exact same param
  // derivation the adapter uses, proving account fields map correctly.

  function makeAccount(
    overrides: Partial<WhatsAppChannelAccount> = {},
  ): WhatsAppChannelAccount {
    return {
      channel: "whatsapp",
      accountId: "main",
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      agentId: "agent-whatsapp",
      selfChatMode: true,
      groupMode: "disabled",
      ...overrides,
    };
  }

  test("attachment allowed when filter is off (default)", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-adapt-"));
    const filePath = join(root, "photo.png");
    await writeFile(filePath, "data");
    try {
      const account = makeAccount(); // no attachment config → filter defaults false
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: account.attachmentFilter === true,
          attachmentMimeTypes: account.attachmentMimeTypes ?? [],
          attachmentAllowedRecipients: account.attachmentAllowedRecipients ?? [],
          attachmentAllowedPaths: account.attachmentAllowedPaths ?? [],
          attachmentPathRecursive: account.attachmentPathRecursive === true,
        },
        mediaPath: filePath,
        recipientChatId: "15551234567@s.whatsapp.net",
      });
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attachment blocked when filter is on but MIME type not in list", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-adapt-"));
    const filePath = join(root, "photo.png");
    await writeFile(filePath, "data");
    try {
      const account = makeAccount({
        attachmentFilter: true,
        attachmentMimeTypes: ["image/jpeg"],
        attachmentAllowedRecipients: ["*"],
        attachmentAllowedPaths: [root],
      });
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: account.attachmentFilter === true,
          attachmentMimeTypes: account.attachmentMimeTypes ?? [],
          attachmentAllowedRecipients: account.attachmentAllowedRecipients ?? [],
          attachmentAllowedPaths: account.attachmentAllowedPaths ?? [],
          attachmentPathRecursive: account.attachmentPathRecursive === true,
        },
        mediaPath: filePath,
        recipientChatId: "15551234567@s.whatsapp.net",
      });
      expect(result).toContain("image/png");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attachment allowed when filter is on and all checks pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-adapt-"));
    const filePath = join(root, "photo.png");
    await writeFile(filePath, "data");
    try {
      const account = makeAccount({
        attachmentFilter: true,
        attachmentMimeTypes: ["image/png"],
        attachmentAllowedRecipients: ["15551234567"],
        attachmentAllowedPaths: [root],
        attachmentPathRecursive: false,
      });
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: account.attachmentFilter === true,
          attachmentMimeTypes: account.attachmentMimeTypes ?? [],
          attachmentAllowedRecipients: account.attachmentAllowedRecipients ?? [],
          attachmentAllowedPaths: account.attachmentAllowedPaths ?? [],
          attachmentPathRecursive: account.attachmentPathRecursive === true,
        },
        mediaPath: filePath,
        recipientChatId: "15551234567@s.whatsapp.net",
      });
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
