import type { ListModelsResponseModelEntry } from "@/types/protocol_v2";
import {
  type ChannelDisplayNameResolver,
  defaultChannelDisplayName,
} from "./command-surface";

export interface RuntimeCommandScope {
  agent_id: string;
  conversation_id: string;
}

export type RuntimeExecuteCommandId = "reflect" | "reload";

export interface RuntimeCommandListModelsResult {
  success: boolean;
  entries: ListModelsResponseModelEntry[];
  availableHandles?: string[] | null;
  error?: string;
}

export interface RuntimeCommandUpdateModelResult {
  success: boolean;
  modelHandle?: string;
  appliedTo?: "agent" | "conversation";
  error?: string;
}

export interface RuntimeCommandAbortResult {
  success: boolean;
  aborted: boolean;
  error?: string;
}

export interface RuntimeCommandExecuteResult {
  success: boolean;
  output: string;
}

export interface RuntimeCommandClient {
  listModels(): Promise<RuntimeCommandListModelsResult>;
  updateModel(params: {
    runtime: RuntimeCommandScope;
    modelIdentifier: string;
  }): Promise<RuntimeCommandUpdateModelResult>;
  abortMessage(params: {
    runtime: RuntimeCommandScope;
    runId: string | null;
  }): Promise<RuntimeCommandAbortResult>;
  executeCommand(params: {
    runtime: RuntimeCommandScope;
    commandId: RuntimeExecuteCommandId;
    args?: string;
  }): Promise<RuntimeCommandExecuteResult>;
}

export type ChannelModelListEntry = Pick<
  ListModelsResponseModelEntry,
  | "id"
  | "handle"
  | "label"
  | "description"
  | "isDefault"
  | "isFeatured"
  | "updateArgs"
>;

const DEFAULT_CHANNEL_MODEL_LIST_LIMIT = 8;

function getModelEntryRank(entry: ChannelModelListEntry): number {
  if (entry.isDefault) return 0;
  if (entry.isFeatured) return 1;
  const effort = (
    entry.updateArgs as { reasoning_effort?: unknown } | undefined
  )?.reasoning_effort;
  if (effort === "medium") return 2;
  if (effort === "high") return 3;
  return 4;
}

function preferModelEntry(
  current: ChannelModelListEntry,
  candidate: ChannelModelListEntry,
): ChannelModelListEntry {
  return getModelEntryRank(candidate) < getModelEntryRank(current)
    ? candidate
    : current;
}

export function buildModelEntriesByHandle(
  entries: ChannelModelListEntry[],
): Map<string, ChannelModelListEntry> {
  const byHandle = new Map<string, ChannelModelListEntry>();
  for (const entry of entries) {
    const current = byHandle.get(entry.handle);
    byHandle.set(
      entry.handle,
      current ? preferModelEntry(current, entry) : entry,
    );
  }
  return byHandle;
}

function makeUnknownModelEntry(handle: string): ChannelModelListEntry {
  return {
    id: handle,
    handle,
    label: handle,
    description: "",
  };
}

export function resolveModelHandles(params: {
  handles: string[];
  byHandle: Map<string, ChannelModelListEntry>;
  availableHandles?: Set<string> | null;
}): ChannelModelListEntry[] {
  const { handles, byHandle, availableHandles } = params;
  const seen = new Set<string>();
  const resolved: ChannelModelListEntry[] = [];
  for (const handle of handles) {
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    if (availableHandles && !availableHandles.has(handle)) continue;
    resolved.push(byHandle.get(handle) ?? makeUnknownModelEntry(handle));
  }
  return resolved;
}

export function getFallbackModelEntries(
  byHandle: Map<string, ChannelModelListEntry>,
): ChannelModelListEntry[] {
  const preferred = Array.from(byHandle.values()).filter(
    (entry) => entry.isDefault || entry.isFeatured,
  );
  return preferred.length > 0 ? preferred : Array.from(byHandle.values());
}

function modelCommandPrefix(channelId: string): "/model" | "@agent /model" {
  return channelId === "slack" ? "@agent /model" : "/model";
}

export function buildChannelModelNotFoundText(channelId: string): string {
  return `Model not found. Use ${modelCommandPrefix(channelId)} list to see available models.`;
}

export function buildChannelCurrentModelMessage(
  channelId: string,
  params: {
    modelLabel: string;
    modelHandle: string | null;
    scope?: "agent" | "conversation";
  },
  displayNameResolver: ChannelDisplayNameResolver = defaultChannelDisplayName,
): string {
  const displayName = displayNameResolver(channelId);
  const scope = params.scope === "agent" ? "agent" : "conversation";
  const handleText =
    params.modelHandle && params.modelHandle !== params.modelLabel
      ? ` (${params.modelHandle})`
      : "";
  const switchCommand = modelCommandPrefix(channelId);
  return [
    `${displayName} current ${scope} model: ${params.modelLabel}${handleText}.`,
    `Use ${switchCommand} list to see available models, or ${switchCommand} <handle-or-id> to switch.`,
  ].join("\n");
}

function formatChannelModelEntry(
  channelId: string,
  entry: ChannelModelListEntry,
): string {
  const selector = entry.id || entry.handle;
  const handleText = entry.handle === entry.label ? "" : ` — ${entry.handle}`;
  return `• ${entry.label}${handleText} (${modelCommandPrefix(channelId)} ${selector})`;
}

function appendModelEntrySection(
  lines: string[],
  channelId: string,
  title: string,
  entries: ChannelModelListEntry[],
  limit: number,
): void {
  if (entries.length === 0) return;
  lines.push("", `${title}:`);
  for (const entry of entries.slice(0, limit)) {
    lines.push(formatChannelModelEntry(channelId, entry));
  }
  const remaining = entries.length - limit;
  if (remaining > 0) {
    lines.push(`…and ${remaining} more.`);
  }
}

export function buildChannelModelListMessage(
  channelId: string,
  params: {
    entries: ListModelsResponseModelEntry[];
    availableHandles?: string[] | null;
    recentHandles?: string[];
    limit?: number;
  },
  displayNameResolver: ChannelDisplayNameResolver = defaultChannelDisplayName,
): string {
  const displayName = displayNameResolver(channelId);
  const limit = params.limit ?? DEFAULT_CHANNEL_MODEL_LIST_LIMIT;
  const entries = params.entries as ChannelModelListEntry[];
  const byHandle = buildModelEntriesByHandle(entries);
  const availableHandleList = Array.isArray(params.availableHandles)
    ? params.availableHandles
    : null;
  const availableSet = availableHandleList
    ? new Set(availableHandleList)
    : null;
  const recentEntries = resolveModelHandles({
    handles: params.recentHandles ?? [],
    byHandle,
    availableHandles: availableSet,
  });
  const availableEntries = availableHandleList
    ? resolveModelHandles({ handles: availableHandleList, byHandle })
    : getFallbackModelEntries(byHandle);

  const lines = [`${displayName} model selector`];
  if (params.availableHandles === null) {
    lines.push(
      "Availability lookup failed; showing built-in recommended models.",
    );
  } else if (params.availableHandles === undefined) {
    lines.push(
      "Available model data was not returned; showing built-in recommended models.",
    );
  }

  appendModelEntrySection(
    lines,
    channelId,
    "Recent models",
    recentEntries,
    limit,
  );
  appendModelEntrySection(
    lines,
    channelId,
    "Available models",
    availableEntries,
    limit,
  );

  if (availableEntries.length === 0) {
    lines.push(
      "",
      "No available models were reported. Use /connect in Letta Code to configure a provider, then try again.",
    );
  }

  lines.push("");
  if (channelId === "slack") {
    lines.push(
      "Mention the app with @agent /model <handle-or-id> to switch this thread's routed model. Use @agent /model to show the current model. Legacy !model still works after a mention.",
    );
  } else {
    lines.push(
      "Use /model <handle-or-id> to switch this chat's routed model, or /model to show the current model.",
    );
  }
  return lines.join("\n");
}

export function buildChannelModelListUnavailableMessage(
  channelId: string,
  error: string,
  displayNameResolver: ChannelDisplayNameResolver = defaultChannelDisplayName,
): string {
  const displayName = displayNameResolver(channelId);
  return `${displayName} could not load the model list: ${error}`;
}

export function buildChannelCurrentModelUnavailableMessage(
  channelId: string,
  error: string,
  displayNameResolver: ChannelDisplayNameResolver = defaultChannelDisplayName,
): string {
  const displayName = displayNameResolver(channelId);
  return `${displayName} could not load the current model: ${error}`;
}

export function buildChannelModelUpdatedMessage(
  channelId: string,
  params: {
    modelLabel: string;
    modelHandle: string;
    appliedTo?: "agent" | "conversation";
  },
  displayNameResolver: ChannelDisplayNameResolver = defaultChannelDisplayName,
): string {
  const displayName = displayNameResolver(channelId);
  const scope = params.appliedTo === "agent" ? "agent" : "conversation";
  const handleText =
    params.modelHandle === params.modelLabel ? "" : ` (${params.modelHandle})`;
  return `${displayName} updated this ${scope}'s model to ${params.modelLabel}${handleText}.`;
}

export function buildChannelModelUpdateFailedMessage(
  channelId: string,
  identifier: string,
  error: string,
  displayNameResolver: ChannelDisplayNameResolver = defaultChannelDisplayName,
): string {
  const displayName = displayNameResolver(channelId);
  return `${displayName} could not switch this chat's routed model to ${identifier}: ${error}`;
}

export function buildChannelCancelAcceptedMessage(
  channelId: string,
  displayNameResolver: ChannelDisplayNameResolver = defaultChannelDisplayName,
): string {
  const displayName = displayNameResolver(channelId);
  return `${displayName} cancelled the in-progress agent turn for this chat.`;
}

export function buildChannelCancelNoActiveTurnMessage(
  channelId: string,
  displayNameResolver: ChannelDisplayNameResolver = defaultChannelDisplayName,
): string {
  const displayName = displayNameResolver(channelId);
  return `${displayName} received /cancel, but there is no in-progress agent turn to cancel for this chat.`;
}

export interface RuntimeCommandReply {
  handled: true;
  text: string;
}

export type ParsedChannelModelCommand =
  | { kind: "current" }
  | { kind: "list" }
  | { kind: "update"; modelIdentifier: string };

export function parseChannelModelCommand(
  args: string,
): ParsedChannelModelCommand {
  const modelIdentifier = args.trim();
  if (!modelIdentifier) {
    return { kind: "current" };
  }
  if (modelIdentifier.toLowerCase() === "list") {
    return { kind: "list" };
  }
  return { kind: "update", modelIdentifier };
}

export async function runChannelModelListCommand(params: {
  channelId: string;
  client: RuntimeCommandClient;
  recentHandles?: string[];
  channelDisplayName?: ChannelDisplayNameResolver;
}): Promise<RuntimeCommandReply> {
  const displayNameResolver =
    params.channelDisplayName ?? defaultChannelDisplayName;
  const result = await params.client.listModels();
  return {
    handled: true,
    text: result.success
      ? buildChannelModelListMessage(
          params.channelId,
          {
            entries: result.entries,
            availableHandles: result.availableHandles,
            recentHandles: params.recentHandles,
          },
          displayNameResolver,
        )
      : buildChannelModelListUnavailableMessage(
          params.channelId,
          result.error ?? "Failed to list models",
          displayNameResolver,
        ),
  };
}

export async function runChannelModelUpdateCommand(params: {
  channelId: string;
  client: RuntimeCommandClient;
  runtime: RuntimeCommandScope;
  modelIdentifier: string;
  resolveModelLabel?: (modelHandle: string) => string | undefined;
  channelDisplayName?: ChannelDisplayNameResolver;
}): Promise<RuntimeCommandReply & { success: boolean; modelHandle?: string }> {
  const displayNameResolver =
    params.channelDisplayName ?? defaultChannelDisplayName;
  const result = await params.client.updateModel({
    runtime: params.runtime,
    modelIdentifier: params.modelIdentifier,
  });
  if (!result.success) {
    return {
      handled: true,
      success: false,
      text: buildChannelModelUpdateFailedMessage(
        params.channelId,
        params.modelIdentifier,
        result.error ?? "Failed to update model",
        displayNameResolver,
      ),
    };
  }
  const appliedHandle = result.modelHandle ?? params.modelIdentifier;
  return {
    handled: true,
    success: true,
    modelHandle: appliedHandle,
    text: buildChannelModelUpdatedMessage(
      params.channelId,
      {
        modelLabel:
          params.resolveModelLabel?.(appliedHandle) ?? params.modelIdentifier,
        modelHandle: appliedHandle,
        appliedTo: result.appliedTo,
      },
      displayNameResolver,
    ),
  };
}

export async function runChannelCancelCommand(params: {
  client: RuntimeCommandClient;
  runtime: RuntimeCommandScope;
  channelId?: string;
  channelDisplayName?: ChannelDisplayNameResolver;
}): Promise<{ handled: true; cancelled: boolean; text?: string }> {
  const response = await params.client.abortMessage({
    runtime: params.runtime,
    runId: null,
  });
  const cancelled = response.success && response.aborted;
  if (params.channelId === undefined) {
    return { handled: true, cancelled };
  }
  const displayNameResolver =
    params.channelDisplayName ?? defaultChannelDisplayName;
  return {
    handled: true,
    cancelled,
    text: cancelled
      ? buildChannelCancelAcceptedMessage(params.channelId, displayNameResolver)
      : buildChannelCancelNoActiveTurnMessage(
          params.channelId,
          displayNameResolver,
        ),
  };
}

async function runChannelExecuteCommand(params: {
  client: RuntimeCommandClient;
  runtime: RuntimeCommandScope;
  commandId: RuntimeExecuteCommandId;
  args?: string;
}): Promise<RuntimeCommandReply> {
  const trimmedArgs = params.args?.trim();
  const response = await params.client.executeCommand({
    runtime: params.runtime,
    commandId: params.commandId,
    ...(trimmedArgs ? { args: trimmedArgs } : {}),
  });
  return { handled: true, text: response.output };
}

export function runChannelReflectionCommand(params: {
  client: RuntimeCommandClient;
  runtime: RuntimeCommandScope;
  args?: string;
}): Promise<RuntimeCommandReply> {
  return runChannelExecuteCommand({ ...params, commandId: "reflect" });
}

export function runChannelReloadCommand(params: {
  client: RuntimeCommandClient;
  runtime: RuntimeCommandScope;
  args?: string;
}): Promise<RuntimeCommandReply> {
  return runChannelExecuteCommand({ ...params, commandId: "reload" });
}
