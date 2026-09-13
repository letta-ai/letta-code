import { expect, mock, test } from "bun:test";
import {
  collectSlackFiles,
  fetchSlackFile,
  resolveSlackFileMetadata,
  resolveSlackMessageFiles,
  type SlackAttachmentReadClient,
  type SlackFileFetcher,
} from "./attachment-primitives";

function createClient(params?: {
  history?: (args: Record<string, unknown>) => Promise<unknown>;
  replies?: (args: Record<string, unknown>) => Promise<unknown>;
}): SlackAttachmentReadClient {
  return {
    conversations: {
      history: mock(params?.history ?? (async () => ({ messages: [] }))),
      replies: mock(params?.replies ?? (async () => ({ messages: [] }))),
    },
  };
}

function bodyResponse(bytes: number[] = [1], init?: ResponseInit): Response {
  return new Response(new Uint8Array(bytes), init);
}

test("collectSlackFiles normalizes nested files and deduplicates by stable identity", () => {
  expect(
    collectSlackFiles({
      files: [
        {
          id: "F1",
          name: "first.png",
          mimetype: "image/png",
          size: 3,
          url_private_download: "https://files.slack.com/first.png",
        },
        { id: "F1", name: "updated.png" },
        null,
      ],
      attachments: [
        {
          files: [
            {
              id: "F2",
              name: "nested.pdf",
              url_private: "https://files.slack.com/nested.pdf",
            },
          ],
          image_url: "https://files.slack.com/preview.png",
        },
      ],
    }),
  ).toEqual([
    { id: "F1", name: "updated.png" },
    {
      id: "F2",
      name: "nested.pdf",
      mimetype: undefined,
      size: undefined,
      url_private: "https://files.slack.com/nested.pdf",
      url_private_download: undefined,
    },
    {
      id: "attachment-image-0",
      name: "attachment-image-0.png",
      url_private: "https://files.slack.com/preview.png",
    },
  ]);
});

test("collectSlackFiles caps one Slack message at eight attachments", () => {
  const files = Array.from({ length: 10 }, (_, index) => ({
    id: `F${index}`,
    name: `${index}.png`,
  }));
  expect(collectSlackFiles({ files }).map((file) => file.id)).toEqual(
    files.slice(0, 8).map((file) => file.id),
  );
});

test("resolveSlackMessageFiles hydrates a thin app_mention from the exact paginated reply", async () => {
  const replies = mock(async (args: Record<string, unknown>) => {
    if (!args.cursor) {
      return {
        messages: [
          {
            ts: "100.1",
            files: [{ id: "FUNRELATED", name: "unrelated.png" }],
          },
        ],
        response_metadata: { next_cursor: "page-2" },
      };
    }
    return {
      messages: [
        {
          ts: "100.2",
          files: [{ id: "FEXACT", name: "exact.png" }],
        },
        {
          ts: "100.3",
          files: [{ id: "FLATER", name: "later.png" }],
        },
      ],
    };
  });
  const client = createClient({ replies });

  await expect(
    resolveSlackMessageFiles({
      channelId: "C123",
      threadTs: "100.1",
      messageTs: "100.2",
      client,
    }),
  ).resolves.toEqual([
    {
      id: "FEXACT",
      name: "exact.png",
      mimetype: undefined,
      size: undefined,
      url_private: undefined,
      url_private_download: undefined,
    },
  ]);
  expect(replies).toHaveBeenNthCalledWith(1, {
    channel: "C123",
    ts: "100.1",
    limit: 200,
    inclusive: true,
  });
  expect(replies).toHaveBeenNthCalledWith(2, {
    channel: "C123",
    ts: "100.1",
    limit: 200,
    inclusive: true,
    cursor: "page-2",
  });
});

test("resolveSlackMessageFiles uses an exact history lookup outside a thread", async () => {
  const history = mock(async () => ({
    messages: [
      {
        ts: "200.1",
        files: [{ id: "FTOP", name: "top.png" }],
      },
    ],
  }));
  const client = createClient({ history });

  const files = await resolveSlackMessageFiles({
    channelId: "C123",
    threadTs: null,
    messageTs: "200.1",
    client,
  });

  expect(files?.map((file) => file.id)).toEqual(["FTOP"]);
  expect(history).toHaveBeenCalledWith({
    channel: "C123",
    oldest: "200.1",
    latest: "200.1",
    inclusive: true,
    limit: 1,
  });
  expect(client.conversations.replies).not.toHaveBeenCalled();
});

test("resolveSlackMessageFiles distinguishes missing messages from messages without files", async () => {
  const client = createClient({
    replies: async () => ({ messages: [{ ts: "100.2", text: "no file" }] }),
  });

  await expect(
    resolveSlackMessageFiles({
      channelId: "C123",
      threadTs: "100.1",
      messageTs: "100.2",
      client,
    }),
  ).resolves.toEqual([]);
  await expect(
    resolveSlackMessageFiles({
      channelId: "C123",
      threadTs: "100.1",
      messageTs: "100.9",
      client,
    }),
  ).resolves.toBeNull();
});

test("fetchSlackFile accepts the Slack file host families", async () => {
  for (const hostname of [
    "files.slack.com",
    "cdn.slack-edge.com",
    "files.slack-files.com",
  ]) {
    const fetcher = mock(async () => bodyResponse());
    const fetched = await fetchSlackFile({
      token: "xoxb-test",
      file: { url_private_download: `https://${hostname}/file.png` },
      fetcher,
    });
    expect(fetched.fileName).toBe("file.png");
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

test("fetchSlackFile rejects non-Slack and non-HTTPS source URLs before fetching", async () => {
  const fetcher = mock(async () => bodyResponse());

  await expect(
    fetchSlackFile({
      token: "xoxb-test",
      file: { url_private_download: "https://slack.com.evil.test/file.png" },
      fetcher,
    }),
  ).rejects.toThrow("Refusing non-Slack attachment host");
  await expect(
    fetchSlackFile({
      token: "xoxb-test",
      file: { url_private_download: "http://files.slack.com/file.png" },
      fetcher,
    }),
  ).rejects.toThrow("Unsupported Slack file protocol");
  expect(fetcher).not.toHaveBeenCalled();
});

test("fetchSlackFile keeps authorization on a same-origin redirect", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: SlackFileFetcher = mock(async (input, init) => {
    calls.push({ url: String(input), init });
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "/download/file.png" },
        })
      : bodyResponse([1, 2], {
          headers: { "content-type": "image/png", "content-length": "2" },
        });
  });

  const fetched = await fetchSlackFile({
    token: "xoxb-test",
    file: {
      id: "F1",
      url_private_download: "https://files.slack.com/files-pri/F1/file",
    },
    fetcher,
  });

  expect(calls).toEqual([
    {
      url: "https://files.slack.com/files-pri/F1/file",
      init: {
        headers: { Authorization: "Bearer xoxb-test" },
        redirect: "manual",
      },
    },
    {
      url: "https://files.slack.com/download/file.png",
      init: {
        headers: { Authorization: "Bearer xoxb-test" },
        redirect: "follow",
      },
    },
  ]);
  expect(fetched).toMatchObject({
    fileName: "file.png",
    mimeType: "image/png",
    contentLength: 2,
  });
});

test("fetchSlackFile strips authorization from a cross-origin redirect", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: SlackFileFetcher = mock(async (input, init) => {
    calls.push({ url: String(input), init });
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://signed.example.test/file.png" },
        })
      : bodyResponse([1]);
  });

  await fetchSlackFile({
    token: "xoxb-test",
    file: { url_private: "https://files.slack.com/original.png" },
    fetcher,
  });

  expect(calls[0]?.init?.headers).toEqual({
    Authorization: "Bearer xoxb-test",
  });
  expect(calls[1]).toEqual({
    url: "https://signed.example.test/file.png",
    init: { redirect: "follow" },
  });
});

test("Slack file metadata prefers specific response MIME and fills missing extensions", async () => {
  expect(
    resolveSlackFileMetadata({
      file: { id: "F1", name: "screenshot" },
      responseMimeType: "image/png",
    }),
  ).toEqual({ fileName: "screenshot.png", mimeType: "image/png" });
  expect(
    resolveSlackFileMetadata({
      file: {
        id: "F2",
        name: "voice.m4a",
        mimetype: "audio/mp4",
      },
      responseMimeType: "application/octet-stream",
    }),
  ).toEqual({ fileName: "voice.m4a", mimeType: "audio/mp4" });
  expect(
    resolveSlackFileMetadata({
      file: { id: "F3", url_private: "https://files.slack.com/photo.webp" },
      url: "https://files.slack.com/photo.webp",
    }),
  ).toEqual({ fileName: "photo.webp", mimeType: "image/webp" });
});

test("fetchSlackFile passes cancellation to every request", async () => {
  const controller = new AbortController();
  const fetcher: SlackFileFetcher = mock(async (_input, init) => {
    expect(init?.signal).toBe(controller.signal);
    throw new DOMException("aborted", "AbortError");
  });
  controller.abort();

  await expect(
    fetchSlackFile({
      token: "xoxb-test",
      file: { url_private: "https://files.slack.com/file.png" },
      signal: controller.signal,
      fetcher,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("fetchSlackFile rejects missing URLs and HTTP failures", async () => {
  const fetcher = mock(async () => bodyResponse([], { status: 403 }));
  await expect(
    fetchSlackFile({ token: "xoxb-test", file: {}, fetcher }),
  ).rejects.toThrow("does not include a private download URL");
  await expect(
    fetchSlackFile({
      token: "xoxb-test",
      file: { url_private: "https://files.slack.com/file.png" },
      fetcher,
    }),
  ).rejects.toThrow("HTTP 403");
});
