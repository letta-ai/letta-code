const MAX_SLACK_ATTACHMENTS = 8;
const ALLOWED_SLACK_HOST_SUFFIXES = [
  "slack.com",
  "slack-edge.com",
  "slack-files.com",
] as const;

export type SlackFileLike = {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

export type SlackAttachmentReadClient = {
  conversations: {
    history(args: {
      channel: string;
      latest?: string;
      oldest?: string;
      limit?: number;
      inclusive?: boolean;
    }): Promise<unknown>;
    replies(args: {
      channel: string;
      ts: string;
      limit?: number;
      inclusive?: boolean;
      cursor?: string;
    }): Promise<unknown>;
  };
};

export type SlackFileFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type SlackFileMetadata = {
  fileName: string;
  mimeType?: string;
};

export type SlackFetchedFile = SlackFileMetadata & {
  body: ReadableStream<Uint8Array>;
  contentLength?: number;
};

type SlackAttachmentLike = {
  image_url?: string;
  files?: SlackFileLike[];
};

type SlackMessageLike = {
  ts?: string;
  files?: unknown[];
  attachments?: unknown[];
};

type SlackMessagePage = {
  messages?: SlackMessageLike[];
  response_metadata?: { next_cursor?: string };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSlackFileLike(value: unknown): SlackFileLike | null {
  const record = asRecord(value);
  if (!record) return null;

  return {
    id: isNonEmptyString(record.id) ? record.id : undefined,
    name: isNonEmptyString(record.name) ? record.name : undefined,
    mimetype: isNonEmptyString(record.mimetype) ? record.mimetype : undefined,
    size: typeof record.size === "number" ? record.size : undefined,
    url_private: isNonEmptyString(record.url_private)
      ? record.url_private
      : undefined,
    url_private_download: isNonEmptyString(record.url_private_download)
      ? record.url_private_download
      : undefined,
  };
}

function normalizeSlackAttachmentLike(
  value: unknown,
): SlackAttachmentLike | null {
  const record = asRecord(value);
  if (!record) return null;

  const files = Array.isArray(record.files)
    ? record.files
        .map((entry) => normalizeSlackFileLike(entry))
        .filter((entry): entry is SlackFileLike => Boolean(entry))
    : undefined;

  return {
    image_url: isNonEmptyString(record.image_url)
      ? record.image_url
      : undefined,
    files,
  };
}

/** Normalize, deduplicate, and cap the Slack files attached to one event/message. */
export function collectSlackFiles(rawEvent: unknown): SlackFileLike[] {
  const record = asRecord(rawEvent);
  if (!record) return [];

  const deduped = new Map<string, SlackFileLike>();
  const push = (file: SlackFileLike | null) => {
    if (!file) return;
    const key =
      file.id ??
      file.url_private_download ??
      file.url_private ??
      `${file.name ?? "attachment"}:${file.mimetype ?? ""}`;
    deduped.set(key, file);
  };

  if (Array.isArray(record.files)) {
    for (const entry of record.files) push(normalizeSlackFileLike(entry));
  }

  if (Array.isArray(record.attachments)) {
    record.attachments
      .map((entry) => normalizeSlackAttachmentLike(entry))
      .filter((entry): entry is SlackAttachmentLike => Boolean(entry))
      .forEach((attachment, index) => {
        for (const file of attachment.files ?? []) push(file);
        if (attachment.image_url) {
          push({
            id: `attachment-image-${index}`,
            name: `attachment-image-${index}.png`,
            url_private: attachment.image_url,
          });
        }
      });
  }

  return Array.from(deduped.values()).slice(0, MAX_SLACK_ATTACHMENTS);
}

function nextCursor(page: SlackMessagePage): string | undefined {
  const value = page.response_metadata?.next_cursor;
  return isNonEmptyString(value) ? value.trim() : undefined;
}

/**
 * Find the exact Slack message and return only its files.
 *
 * `null` means the message was not present in the requested chat/thread. An
 * empty array means the message existed but had no files. This distinction lets
 * explicit downloads reject a file id without searching outside its source
 * message, while thin app_mention payloads can safely hydrate their canonical
 * files through conversations.replies.
 */
export async function resolveSlackMessageFiles(params: {
  channelId: string;
  threadTs?: string | null;
  messageTs: string;
  client: SlackAttachmentReadClient;
}): Promise<SlackFileLike[] | null> {
  if (isNonEmptyString(params.threadTs)) {
    let cursor: string | undefined;
    do {
      const page = (await params.client.conversations.replies({
        channel: params.channelId,
        ts: params.threadTs,
        limit: 200,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      })) as SlackMessagePage;
      const message = (page.messages ?? []).find(
        (entry) => entry.ts === params.messageTs,
      );
      if (message) return collectSlackFiles(message);
      cursor = nextCursor(page);
    } while (cursor);
    return null;
  }

  const page = (await params.client.conversations.history({
    channel: params.channelId,
    oldest: params.messageTs,
    latest: params.messageTs,
    inclusive: true,
    limit: 1,
  })) as SlackMessagePage;
  const message = (page.messages ?? []).find(
    (entry) => entry.ts === params.messageTs,
  );
  return message ? collectSlackFiles(message) : null;
}

function isAllowedSlackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return ALLOWED_SLACK_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function assertSlackFileUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") {
    throw new Error(`Unsupported Slack file protocol: ${parsed.protocol}`);
  }
  if (!isAllowedSlackHostname(parsed.hostname)) {
    throw new Error(`Refusing non-Slack attachment host: ${parsed.hostname}`);
  }
  return parsed;
}

function extensionForMimeType(mimeType?: string): string {
  switch (mimeType?.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "audio/aac":
      return ".aac";
    case "audio/m4a":
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/mpeg":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/webm":
      return ".webm";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}

function pathBaseName(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  const separator = trimmed.lastIndexOf("/");
  return trimmed.slice(separator + 1);
}

function extensionName(name: string): string {
  const base = pathBaseName(name);
  if (base === "..") return "";
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index) : "";
}

function resolveMimeType(name: string, fallback?: string): string | undefined {
  if (fallback) return fallback;

  switch (extensionName(name).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".aac":
      return "audio/aac";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".oga":
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".webm":
      return "audio/webm";
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".md":
      return "text/plain";
    default:
      return undefined;
  }
}

function isGenericSlackMimeType(mimeType?: string): boolean {
  const normalized = mimeType?.trim().toLowerCase();
  return (
    normalized === "application/octet-stream" ||
    normalized === "binary/octet-stream"
  );
}

function resolveSlackFileName(params: {
  file: SlackFileLike;
  url?: string;
  mimeType?: string;
}): string {
  const hintedName =
    params.file.name ??
    (params.url ? pathBaseName(new URL(params.url).pathname) : undefined) ??
    `${params.file.id ?? "attachment"}${extensionForMimeType(params.file.mimetype)}`;
  return extensionName(hintedName) || !params.mimeType
    ? hintedName
    : `${hintedName}${extensionForMimeType(params.mimeType)}`;
}

function resolveSlackFileMimeType(params: {
  file: SlackFileLike;
  fileName: string;
  responseMimeType?: string;
}): string | undefined {
  const preferredMimeType =
    params.responseMimeType && !isGenericSlackMimeType(params.responseMimeType)
      ? params.responseMimeType
      : params.file.mimetype && !isGenericSlackMimeType(params.file.mimetype)
        ? params.file.mimetype
        : undefined;
  return resolveMimeType(params.fileName, preferredMimeType);
}

export function resolveSlackFileMetadata(params: {
  file: SlackFileLike;
  url?: string;
  responseMimeType?: string;
}): SlackFileMetadata {
  const hintedName = resolveSlackFileName({
    file: params.file,
    url: params.url,
  });
  const mimeType = resolveSlackFileMimeType({
    file: params.file,
    fileName: hintedName,
    responseMimeType: params.responseMimeType,
  });
  return {
    fileName: resolveSlackFileName({
      file: params.file,
      url: params.url,
      mimeType,
    }),
    mimeType,
  };
}

function parseContentLength(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (!header) return undefined;
  const value = Number(header);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Open a private Slack file without forwarding the bot token to another origin.
 * The returned body remains streaming; callers choose their own byte and idle
 * limits before materializing it.
 */
export async function fetchSlackFile(params: {
  token: string;
  file: SlackFileLike;
  signal?: AbortSignal;
  fetcher?: SlackFileFetcher;
}): Promise<SlackFetchedFile> {
  const rawUrl = params.file.url_private_download ?? params.file.url_private;
  if (!rawUrl) {
    throw new Error(
      "Slack attachment does not include a private download URL.",
    );
  }

  const parsed = assertSlackFileUrl(rawUrl);
  const fetcher = params.fetcher ?? globalThis.fetch;
  const authHeaders = { Authorization: `Bearer ${params.token}` };
  const initial = await fetcher(parsed.href, {
    headers: authHeaders,
    redirect: "manual",
    ...(params.signal ? { signal: params.signal } : {}),
  });

  let response = initial;
  if (initial.status >= 300 && initial.status < 400) {
    const location = initial.headers.get("location");
    if (location) {
      const resolved = new URL(location, parsed.href);
      response = await fetcher(resolved.href, {
        ...(resolved.origin === parsed.origin ? { headers: authHeaders } : {}),
        redirect: "follow",
        ...(params.signal ? { signal: params.signal } : {}),
      });
    }
  }

  if (!response.ok) {
    throw new Error(
      `Slack attachment fetch failed with HTTP ${response.status}.`,
    );
  }
  if (!response.body) {
    throw new Error("Slack attachment response did not include a body.");
  }

  const responseMimeType =
    response.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
  const metadata = resolveSlackFileMetadata({
    file: params.file,
    url: rawUrl,
    responseMimeType,
  });

  return {
    body: response.body,
    ...metadata,
    contentLength: parseContentLength(response),
  };
}
