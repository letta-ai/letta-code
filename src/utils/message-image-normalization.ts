import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { resizeImageIfNeeded } from "@/utils/image-resize";

export const SUPPORTED_BASE64_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isSupportedBase64ImageMediaType(mediaType: string): boolean {
  return SUPPORTED_BASE64_IMAGE_MEDIA_TYPES.has(mediaType);
}

export type Base64ImageContentPart = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};

export type ImageNormalizationFailureMode = "strict" | "drop";

export type ImageFailureModesByMessageOtid = Readonly<
  Record<string, ImageNormalizationFailureMode>
>;

type NormalizeMessageImagePartsOptions = {
  failureModesByMessageOtid?: ImageFailureModesByMessageOtid;
  resize?: typeof resizeImageIfNeeded;
};

function formatImageNormalizationError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to prepare image for model: ${detail}`);
}

export function isBase64ImageContentPart(
  part: unknown,
): part is Base64ImageContentPart {
  if (!part || typeof part !== "object") {
    return false;
  }

  const candidate = part as {
    type?: unknown;
    source?: {
      type?: unknown;
      media_type?: unknown;
      data?: unknown;
    };
  };

  return (
    candidate.type === "image" &&
    !!candidate.source &&
    candidate.source.type === "base64" &&
    typeof candidate.source.media_type === "string" &&
    candidate.source.media_type.length > 0 &&
    typeof candidate.source.data === "string" &&
    candidate.source.data.length > 0
  );
}

async function normalizeMessageContentImages<
  T extends MessageCreate["content"],
>(
  content: T,
  resize: typeof resizeImageIfNeeded = resizeImageIfNeeded,
  failureMode: ImageNormalizationFailureMode = "strict",
): Promise<T> {
  if (typeof content === "string") {
    return content;
  }

  let didChange = false;
  const normalizedParts = await Promise.all(
    content.map(async (part) => {
      if (!isBase64ImageContentPart(part)) {
        return part;
      }

      let resized: Awaited<ReturnType<typeof resize>>;
      try {
        resized = await resize(
          Buffer.from(part.source.data, "base64"),
          part.source.media_type,
        );
      } catch (error) {
        if (failureMode === "drop") {
          didChange = true;
          return null;
        }
        throw formatImageNormalizationError(error);
      }

      if (!isSupportedBase64ImageMediaType(resized.mediaType)) {
        if (failureMode === "drop") {
          didChange = true;
          return null;
        }
        throw new Error(
          `Unsupported base64 image media type after normalization: ${resized.mediaType}`,
        );
      }

      if (
        resized.data !== part.source.data ||
        resized.mediaType !== part.source.media_type
      ) {
        didChange = true;
      }

      return {
        ...part,
        source: {
          ...part.source,
          type: "base64" as const,
          data: resized.data,
          media_type: resized.mediaType,
        },
      };
    }),
  );

  const filteredParts = normalizedParts.filter(
    (part): part is Exclude<(typeof normalizedParts)[number], null> =>
      part !== null,
  );

  return (didChange ? filteredParts : content) as T;
}

async function normalizeApprovalImages(
  message: ApprovalCreate,
  resize: typeof resizeImageIfNeeded,
  failureMode: ImageNormalizationFailureMode,
): Promise<ApprovalCreate> {
  if (!Array.isArray(message.approvals)) {
    return message;
  }

  let didChange = false;
  const approvals = await Promise.all(
    message.approvals.map(async (approval) => {
      if (!("tool_return" in approval)) {
        return approval;
      }

      const toolReturn = await normalizeMessageContentImages(
        approval.tool_return,
        resize,
        failureMode,
      );
      if (toolReturn === approval.tool_return) {
        return approval;
      }

      didChange = true;
      return {
        ...approval,
        tool_return: toolReturn,
      };
    }),
  );

  return didChange ? { ...message, approvals } : message;
}

export async function normalizeMessageImageParts<
  T extends ApprovalCreate | MessageCreate,
>(
  messages: T[],
  options: NormalizeMessageImagePartsOptions = {},
): Promise<T[]> {
  let didChange = false;
  const resize = options.resize ?? resizeImageIfNeeded;

  const normalizedMessages = await Promise.all(
    messages.map(async (message) => {
      const failureMode = getImageFailureMode(
        message,
        options.failureModesByMessageOtid,
      );
      if (!("content" in message)) {
        const normalizedApproval = await normalizeApprovalImages(
          message,
          resize,
          failureMode,
        );
        if (normalizedApproval !== message) {
          didChange = true;
        }
        return normalizedApproval as T;
      }

      const normalizedContent = await normalizeMessageContentImages(
        message.content,
        resize,
        failureMode,
      );
      if (normalizedContent !== message.content) {
        didChange = true;
        return {
          ...message,
          content: normalizedContent,
        };
      }
      return message;
    }),
  );

  return didChange ? normalizedMessages : messages;
}

function getImageFailureMode(
  message: ApprovalCreate | MessageCreate,
  failureModesByMessageOtid?: ImageFailureModesByMessageOtid,
): ImageNormalizationFailureMode {
  if (!failureModesByMessageOtid) {
    return "strict";
  }

  const otid = (message as { otid?: unknown }).otid;
  return typeof otid === "string"
    ? (failureModesByMessageOtid[otid] ?? "strict")
    : "strict";
}

export function buildImageFailureModesByMessageOtid(
  messages: Array<ApprovalCreate | MessageCreate>,
  failureMode: ImageNormalizationFailureMode,
): ImageFailureModesByMessageOtid | undefined {
  const entries: Array<[string, ImageNormalizationFailureMode]> = [];
  for (const message of messages) {
    if (!("content" in message)) {
      continue;
    }
    const otid = (message as { otid?: unknown }).otid;
    if (typeof otid === "string" && otid.length > 0) {
      entries.push([otid, failureMode]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function mergeImageFailureModesByMessageOtid(
  ...failureModes: Array<ImageFailureModesByMessageOtid | undefined>
): ImageFailureModesByMessageOtid | undefined {
  const presentModes = failureModes.filter(
    (modes): modes is ImageFailureModesByMessageOtid => modes !== undefined,
  );
  return presentModes.length > 0
    ? Object.assign({}, ...presentModes)
    : undefined;
}

export function assertSupportedBase64ImageMediaTypes(
  messages: Array<ApprovalCreate | MessageCreate>,
): void {
  for (const message of messages) {
    if ("content" in message) {
      assertSupportedBase64ImageContent(message.content);
      continue;
    }

    for (const approval of message.approvals ?? []) {
      if (!("tool_return" in approval)) {
        continue;
      }
      assertSupportedBase64ImageContent(approval.tool_return);
    }
  }
}

function assertSupportedBase64ImageContent(
  content: MessageCreate["content"],
): void {
  if (typeof content === "string") {
    return;
  }

  for (const part of content) {
    if (
      isBase64ImageContentPart(part) &&
      !isSupportedBase64ImageMediaType(part.source.media_type)
    ) {
      throw new Error(
        `Unsupported base64 image media type after normalization: ${part.source.media_type}`,
      );
    }
  }
}
