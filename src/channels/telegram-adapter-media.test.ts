import { expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { InboundChannelMessage } from "@/channels/types";
import {
  consoleWarnSpy,
  createTelegramAdapter,
  FakeBot,
  installTelegramAdapterTestHooks,
  MAX_TELEGRAM_DOWNLOAD_BYTES,
  resetTelegramChannelRoot,
  telegramAccountDefaults,
  withTimeout,
} from "./telegram/adapter-test-harness";

installTelegramAdapterTestHooks();

test("telegram adapter batches media groups and downloads inbound images", async () => {
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();
    const fileName = href.endsWith("photo2.jpg") ? "second" : "first";
    const content = Buffer.from(`image-${fileName}`);
    return new Response(content, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async (fileId) => ({
    file_path: fileId === "photo2" ? "photos/photo2.jpg" : "photos/photo1.jpg",
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  let resolveInboundMessage:
    | ((message: InboundChannelMessage) => void)
    | undefined;
  const inboundMessage = new Promise<InboundChannelMessage>((resolve) => {
    resolveInboundMessage = resolve;
  });
  const onMessage = mock(async (message: InboundChannelMessage) => {
    resolveInboundMessage?.(message);
  });
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  try {
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        caption: "Vacation photos",
        date: 1_736_380_800,
        message_id: 10,
        media_group_id: "album-1",
        photo: [
          { file_id: "photo1", file_unique_id: "unique-1", file_size: 12 },
        ],
      },
    });
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        date: 1_736_380_801,
        message_id: 11,
        media_group_id: "album-1",
        photo: [
          { file_id: "photo2", file_unique_id: "unique-2", file_size: 13 },
        ],
      },
    });

    const inbound = await withTimeout(
      inboundMessage,
      2_000,
      "Timed out waiting for Telegram media group flush",
    );

    expect(onMessage).toHaveBeenCalledTimes(1);

    expect(inbound.text).toBe("Vacation photos");
    expect(inbound.attachments).toHaveLength(2);
    expect(
      inbound.attachments?.every((attachment) => attachment.kind === "image"),
    ).toBe(true);

    const localPaths = inbound.attachments
      ?.map((attachment) => attachment.localPath)
      .filter((value): value is string => typeof value === "string");
    expect(localPaths).toHaveLength(2);

    for (const localPath of localPaths ?? []) {
      expect(existsSync(localPath)).toBe(true);
      expect(readFileSync(localPath, "utf-8").startsWith("image-")).toBe(true);
    }
  } finally {
    resetTelegramChannelRoot();
  }
});

test("telegram adapter preserves photo mime type when Telegram download responds with octet-stream", async () => {
  globalThis.fetch = mock(
    async () =>
      new Response(Buffer.from("fake-jpeg"), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
  ) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "photos/photo.jpg",
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  try {
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        date: 1_736_380_800,
        message_id: 10,
        photo: [
          { file_id: "photo1", file_unique_id: "unique-1", file_size: 9 },
        ],
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const firstCall = onMessage.mock.calls[0] as unknown as
      | [InboundChannelMessage]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected inbound Telegram photo to emit a message");
    }

    const [inbound] = firstCall;
    expect(inbound.attachments).toHaveLength(1);
    expect(inbound.attachments?.[0]).toMatchObject({
      kind: "image",
      mimeType: "image/jpeg",
      imageDataBase64: Buffer.from("fake-jpeg").toString("base64"),
    });
  } finally {
    resetTelegramChannelRoot();
  }
});

test("telegram adapter does not inline SVG documents as model images", async () => {
  const svgBytes = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ff6600" /></svg>',
  );
  globalThis.fetch = mock(
    async () =>
      new Response(svgBytes, {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      }),
  ) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "documents/void-final.svg",
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  try {
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        caption: "Extract the colors",
        date: 1_736_380_800,
        message_id: 10,
        document: {
          file_id: "svg1",
          file_name: "void-final.svg",
          mime_type: "image/svg+xml",
          file_size: svgBytes.byteLength,
        },
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const firstCall = onMessage.mock.calls[0] as unknown as
      | [InboundChannelMessage]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected inbound Telegram SVG to emit a message");
    }

    const [inbound] = firstCall;
    expect(inbound.attachments).toHaveLength(1);
    const attachment = inbound.attachments?.[0];
    expect(attachment).toMatchObject({
      kind: "image",
      name: "void-final.svg",
      mimeType: "image/svg+xml",
      sizeBytes: svgBytes.byteLength,
    });
    expect(attachment?.imageDataBase64).toBeUndefined();
    expect(attachment?.localPath).toBeDefined();
    if (!attachment?.localPath) {
      throw new Error("Expected inbound Telegram SVG to be saved locally");
    }
    expect(readFileSync(attachment.localPath)).toEqual(svgBytes);
  } finally {
    resetTelegramChannelRoot();
  }
});

test("telegram adapter downloads inbound wav documents as audio", async () => {
  const wavBytes = Buffer.from("wav-bytes");
  globalThis.fetch = mock(
    async () =>
      new Response(wavBytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
  ) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "documents/clip",
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  try {
    await bot?.emit("message", {
      message: {
        chat: { id: 123 },
        from: { id: 456, username: "alice", first_name: "Alice" },
        date: 1_736_380_800,
        message_id: 10,
        document: {
          file_id: "wav1",
          file_name: "clip.wav",
          file_size: wavBytes.byteLength,
        },
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const firstCall = onMessage.mock.calls[0] as unknown as
      | [InboundChannelMessage]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected inbound Telegram WAV to emit a message");
    }

    const [inbound] = firstCall;
    expect(inbound.attachments).toHaveLength(1);
    const attachment = inbound.attachments?.[0];
    expect(attachment).toMatchObject({
      kind: "audio",
      name: "clip.wav",
      mimeType: "audio/wav",
      sizeBytes: wavBytes.byteLength,
    });
    expect(attachment?.localPath).toBeDefined();
    if (!attachment?.localPath) {
      throw new Error("Expected inbound Telegram WAV to be saved locally");
    }
    expect(readFileSync(attachment.localPath)).toEqual(wavBytes);
  } finally {
    resetTelegramChannelRoot();
  }
});

test("telegram adapter logs when oversized inbound attachments are skipped", async () => {
  globalThis.fetch = mock(async () => {
    throw new Error("oversized attachment should not be downloaded");
  }) as unknown as typeof fetch;

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  const oversizedBytes = MAX_TELEGRAM_DOWNLOAD_BYTES + 1;
  await bot?.emit("message", {
    message: {
      chat: { id: 123 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "Oversized attachment",
      date: 1_736_380_800,
      message_id: 10,
      document: {
        file_id: "too-big",
        file_name: "too-big.wav",
        file_size: oversizedBytes,
      },
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({ attachments: undefined }),
  );
  expect(bot?.api.getFile).not.toHaveBeenCalled();
  expect(consoleWarnSpy).toHaveBeenCalledWith(
    `[Telegram] Skipping attachment too-big.wav: ${oversizedBytes} bytes exceeds Telegram download limit (${MAX_TELEGRAM_DOWNLOAD_BYTES} bytes).`,
  );
});

test("telegram adapter logs attachment download failures", async () => {
  globalThis.fetch = mock(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  FakeBot.nextGetFileImpl = async () => ({
    file_path: "documents/fail.wav",
  });

  const adapter = createTelegramAdapter({
    ...telegramAccountDefaults,
    channel: "telegram",
    enabled: true,
    token: "test-token",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();

  const bot = FakeBot.instances[0];
  await bot?.emit("message", {
    message: {
      chat: { id: 123 },
      from: { id: 456, username: "alice", first_name: "Alice" },
      text: "Download this",
      date: 1_736_380_800,
      message_id: 10,
      document: {
        file_id: "fail",
        file_name: "fail.wav",
        file_size: 9,
      },
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({ attachments: undefined }),
  );
  expect(consoleWarnSpy).toHaveBeenCalledWith(
    "[Telegram] Attachment download failed for fail.wav: network down",
  );
});
