import type { TextStreamPart, ToolSet, UIMessage } from "ai";

export type ProviderStreamPart = TextStreamPart<ToolSet>;

const PROVIDER_STREAM_PART = Symbol.for("@letta/provider-stream-part");
const PROVIDER_UI_MESSAGE = Symbol.for("@letta/provider-ui-message");
const PROVIDER_STREAM_PART_ONLY = Symbol.for(
  "@letta/provider-stream-part-only",
);

export interface ProviderTrajectoryProviderMetadata {
  providerId?: string;
  modelId?: string;
  responseId?: string;
  providerMetadata?: unknown;
}

export interface ProviderTrajectoryLettaProjection {
  messageTypes: string[];
  otids?: string[];
  messageIds: string[];
  approvalRequestIds?: string[];
  approvalResponseIds?: string[];
  toolCallIds?: string[];
}

export interface ProviderTrajectoryUIMessageMetadata {
  provider?: ProviderTrajectoryProviderMetadata;
  lettaProjection?: ProviderTrajectoryLettaProjection;
}

export type ProviderTrajectoryUIMessage =
  UIMessage<ProviderTrajectoryUIMessageMetadata>;

export interface ProviderTrajectoryRawCapture {
  streamParts?: unknown[];
  request?: unknown;
  response?: unknown;
  responseMessages?: unknown[];
  steps?: unknown[];
  providerMetadata?: unknown;
  warnings?: unknown[];
  usage?: unknown;
}

export interface ProviderTrajectoryMessage {
  type: "letta_provider_ui_message";
  schemaVersion: 1;
  id: string;
  date: string;
  agentId: string;
  conversationId: string;
  uiMessage: ProviderTrajectoryUIMessage;
  raw?: ProviderTrajectoryRawCapture;
}

export function cloneProviderStreamPart(
  part: ProviderStreamPart,
): ProviderStreamPart {
  return cloneUnknown(part) as ProviderStreamPart;
}

export function cloneProviderUIMessageSnapshot(
  message: ProviderTrajectoryUIMessage,
): ProviderTrajectoryUIMessage {
  return cloneUnknown(message) as ProviderTrajectoryUIMessage;
}

export function attachProviderStreamPart<T extends object>(
  target: T,
  part: ProviderStreamPart,
): T {
  Object.defineProperty(target, PROVIDER_STREAM_PART, {
    value: part,
    enumerable: false,
    configurable: false,
  });
  return target;
}

export function getAttachedProviderStreamPart(
  value: unknown,
): ProviderStreamPart | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<symbol, ProviderStreamPart | undefined>)[
    PROVIDER_STREAM_PART
  ];
}

export function attachProviderUIMessage<T extends object>(
  target: T,
  message: ProviderTrajectoryUIMessage,
): T {
  Object.defineProperty(target, PROVIDER_UI_MESSAGE, {
    value: message,
    enumerable: false,
    configurable: false,
  });
  return target;
}

export function getAttachedProviderUIMessage(
  value: unknown,
): ProviderTrajectoryUIMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<symbol, ProviderTrajectoryUIMessage | undefined>)[
    PROVIDER_UI_MESSAGE
  ];
}

export function markProviderStreamPartOnly<T extends object>(target: T): T {
  Object.defineProperty(target, PROVIDER_STREAM_PART_ONLY, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return target;
}

export function isProviderStreamPartOnly(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, boolean | undefined>)[
      PROVIDER_STREAM_PART_ONLY
    ] === true
  );
}

function cloneUnknown(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      return String(value);
    }
  }
}

function clonePart(
  part: ProviderTrajectoryUIMessage["parts"][number],
): ProviderTrajectoryUIMessage["parts"][number] {
  return { ...part } as ProviderTrajectoryUIMessage["parts"][number];
}

export function cloneProviderUIMessage(
  message: ProviderTrajectoryUIMessage,
): ProviderTrajectoryUIMessage {
  return {
    ...message,
    metadata: message.metadata
      ? {
          ...message.metadata,
          lettaProjection: message.metadata.lettaProjection
            ? {
                ...message.metadata.lettaProjection,
                messageTypes: [
                  ...message.metadata.lettaProjection.messageTypes,
                ],
                otids: message.metadata.lettaProjection.otids
                  ? [...message.metadata.lettaProjection.otids]
                  : undefined,
                messageIds: [...message.metadata.lettaProjection.messageIds],
                approvalRequestIds: message.metadata.lettaProjection
                  .approvalRequestIds
                  ? [...message.metadata.lettaProjection.approvalRequestIds]
                  : undefined,
                approvalResponseIds: message.metadata.lettaProjection
                  .approvalResponseIds
                  ? [...message.metadata.lettaProjection.approvalResponseIds]
                  : undefined,
                toolCallIds: message.metadata.lettaProjection.toolCallIds
                  ? [...message.metadata.lettaProjection.toolCallIds]
                  : undefined,
              }
            : undefined,
        }
      : undefined,
    parts: message.parts.map(clonePart),
  };
}

export function providerUIMessages(
  trajectory: ProviderTrajectoryMessage[],
): ProviderTrajectoryUIMessage[] {
  return trajectory.map((entry) => cloneProviderUIMessage(entry.uiMessage));
}
