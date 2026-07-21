import {
  type AgentContext,
  type CancelNotification,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import {
  type CanUseToolResponse,
  LettaAgentClient,
  type LettaCodeSession,
  type MessageContentItem,
  type SDKMessage,
  type SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";
import type { LettaAcpConfig } from "./config.js";
import { toolKind, toolLocations, toolTitle } from "./tool-info.js";

interface AcpSessionState {
  session: LettaCodeSession;
  /** ACP context of the in-flight prompt; permission requests need it. */
  promptContext: AgentContext | null;
  /** Most recent tool_call streamed, to correlate permission requests. */
  lastToolCall: { id: string; name: string } | null;
  /** Tools the user chose "always allow" for, scoped to this session. */
  alwaysAllowed: Set<string>;
  cancelled: boolean;
}

type PumpOutcome =
  | { kind: "result"; result: SDKResultMessage }
  | { kind: "idle" }
  | { kind: "stream_end" };

const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Bridges ACP v1 (agent side) onto a Letta agent via the Letta Agent SDK.
 *
 * One process serves one ACP connection. Every ACP session becomes a new
 * Letta conversation on a single underlying Letta agent, so the agent's
 * memory persists across sessions and editors.
 */
export class LettaAcpAgent {
  private readonly config: LettaAcpConfig;
  private readonly client: LettaAgentClient;
  private readonly sessions = new Map<string, AcpSessionState>();
  private agentIdPromise: Promise<string> | null = null;

  constructor(config: LettaAcpConfig) {
    this.config = config;
    this.client = new LettaAgentClient(config.clientOptions);
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === "number" && requested < PROTOCOL_VERSION
        ? requested
        : PROTOCOL_VERSION;
    return {
      protocolVersion,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
      },
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const agentId = await this.ensureAgent();
    const sessionId = `sess_${crypto.randomUUID()}`;
    const session = this.client.createSession(agentId, {
      cwd: params.cwd,
      model: this.config.model,
      permissionMode: this.config.permissionMode,
      canUseTool: (toolName, toolInput) =>
        this.requestToolPermission(sessionId, toolName, toolInput),
    });
    this.sessions.set(sessionId, {
      session,
      promptContext: null,
      lastToolCall: null,
      alwaysAllowed: new Set(),
      cancelled: false,
    });
    log(`session ${sessionId} -> agent ${agentId} (cwd: ${params.cwd})`);
    return { sessionId };
  }

  async prompt(
    params: PromptRequest,
    cx: AgentContext,
  ): Promise<PromptResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    state.promptContext = cx;
    state.cancelled = false;

    try {
      await state.session.send(toLettaContent(params.prompt));
      // The Letta app-server transport completes a turn with a recoverable
      // "approval_conflict" result whenever a tool needs user approval. The
      // approval itself resolves concurrently: the server sends a
      // can_use_tool control request, our canUseTool callback forwards it to
      // the ACP client, and once answered the run resumes and its events keep
      // streaming — but with no second terminal result message. So: pump the
      // first round to its result, then pump recovery rounds (blocking on the
      // stream while approvals resolve) until the run goes idle.
      let mode: "turn" | "recovery" = "turn";
      while (true) {
        const outcome = await this.pumpStream(
          params.sessionId,
          state,
          cx,
          mode,
        );
        if (state.cancelled) return { stopReason: "cancelled" };
        switch (outcome.kind) {
          case "result": {
            const result = outcome.result;
            if (!result.success && result.errorCode === "approval_conflict") {
              mode = "recovery";
              continue;
            }
            return this.toPromptResponse(state, result);
          }
          case "idle":
          case "stream_end":
            return { stopReason: "end_turn" };
        }
      }
    } catch (error) {
      if (state.cancelled) return { stopReason: "cancelled" };
      throw error;
    } finally {
      state.promptContext = null;
    }
  }

  /**
   * Iterates one session.stream() round, forwarding events to the client.
   * In "recovery" mode (post-approval continuation) there is no terminal
   * result message, so loop_status transitions decide when the turn is over.
   * Blocking on the stream while an approval is pending is fine — the
   * canUseTool round-trip resolves concurrently over the control channel.
   */
  private async pumpStream(
    sessionId: string,
    state: AcpSessionState,
    cx: AgentContext,
    mode: "turn" | "recovery",
  ): Promise<PumpOutcome> {
    let sawActivity = false;
    let idleStatusCount = 0;
    for await (const message of state.session.stream()) {
      if (message.type === "result") {
        return { kind: "result", result: message };
      }
      if (message.type === "loop_status" && mode === "recovery") {
        if (message.status === "WAITING_ON_INPUT") {
          idleStatusCount += 1;
          // The first idle status can be stale (queued before the resume);
          // trust it once we've seen real activity or it repeats.
          if (sawActivity || idleStatusCount >= 2 || state.cancelled) {
            return { kind: "idle" };
          }
        }
        continue;
      }
      const forwarded = await this.forwardMessage(
        sessionId,
        state,
        message,
        cx,
      );
      sawActivity = sawActivity || forwarded;
    }
    return { kind: "stream_end" };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const state = this.sessions.get(params.sessionId);
    if (!state) return;
    state.cancelled = true;
    try {
      await state.session.abort();
    } catch (error) {
      log(`abort failed for ${params.sessionId}: ${String(error)}`);
    }
  }

  shutdown(): void {
    for (const state of this.sessions.values()) {
      try {
        state.session.close();
      } catch {
        // best-effort cleanup on connection close
      }
    }
    this.sessions.clear();
  }

  /**
   * Streamed Letta SDK message -> ACP session/update notification.
   * Returns true when the message was substantive turn activity.
   */
  private async forwardMessage(
    sessionId: string,
    state: AcpSessionState,
    message: SDKMessage,
    cx: AgentContext,
  ): Promise<boolean> {
    switch (message.type) {
      case "init":
        log(`turn started (agent ${message.agentId}, model ${message.model})`);
        return false;
      case "assistant":
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: message.content },
          },
        });
        return true;
      case "reasoning":
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: message.content },
          },
        });
        return true;
      case "tool_call":
        state.lastToolCall = { id: message.toolCallId, name: message.toolName };
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: message.toolCallId,
            title: toolTitle(message.toolName, message.toolInput),
            kind: toolKind(message.toolName),
            status: "in_progress",
            rawInput: message.toolInput,
            locations: toolLocations(message.toolInput),
          },
        });
        return true;
      case "tool_result":
        await cx.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: message.toolCallId,
            status: message.isError ? "failed" : "completed",
            content: [
              {
                type: "content",
                content: { type: "text", text: message.content },
              },
            ],
          },
        });
        return true;
      case "error":
        log(`stream error: ${message.message}`);
        return false;
      default:
        // queue_update, loop_status, stream_event, retry — no ACP equivalent.
        return false;
    }
  }

  private toPromptResponse(
    state: AcpSessionState,
    result: SDKResultMessage,
  ): PromptResponse {
    if (result.success) {
      return { stopReason: "end_turn" };
    }
    let stopReason: StopReason;
    switch (result.errorCode) {
      case "interrupted":
        stopReason = "cancelled";
        break;
      case "max_steps":
        stopReason = "max_turn_requests";
        break;
      default:
        if (state.cancelled) {
          stopReason = "cancelled";
          break;
        }
        throw new Error(
          result.errorDetail ?? result.error ?? "Letta turn failed",
        );
    }
    return { stopReason };
  }

  /** Letta canUseTool callback -> ACP session/request_permission. */
  private async requestToolPermission(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<CanUseToolResponse> {
    const state = this.sessions.get(sessionId);
    const cx = state?.promptContext;
    if (!state || !cx) {
      return {
        behavior: "deny",
        message: "No active ACP prompt to request permission from",
      };
    }
    return this.resolveToolPermission(
      sessionId,
      state,
      cx,
      toolName,
      toolInput,
    );
  }

  private async resolveToolPermission(
    sessionId: string,
    state: AcpSessionState,
    cx: AgentContext,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<CanUseToolResponse> {
    log(`permission requested for ${toolName}`);
    if (state.alwaysAllowed.has(toolName)) {
      return { behavior: "allow", updatedInput: toolInput };
    }

    const toolCallId =
      state.lastToolCall?.name === toolName
        ? state.lastToolCall.id
        : `${toolName}_${crypto.randomUUID()}`;
    const response = await cx.request(
      methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          toolCallId,
          title: toolTitle(toolName, toolInput),
          kind: toolKind(toolName),
          status: "pending",
          rawInput: toolInput,
          locations: toolLocations(toolInput),
        },
        options: [
          {
            optionId: "allow_once",
            name: `Allow ${toolName} once`,
            kind: "allow_once",
          },
          {
            optionId: "allow_always",
            name: `Always allow ${toolName} this session`,
            kind: "allow_always",
          },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      },
    );

    if (response.outcome.outcome === "cancelled") {
      return {
        behavior: "deny",
        message: "Prompt turn was cancelled",
        interrupt: true,
      };
    }
    switch (response.outcome.optionId) {
      case "allow_always":
        state.alwaysAllowed.add(toolName);
        return { behavior: "allow", updatedInput: toolInput };
      case "allow_once":
        return { behavior: "allow", updatedInput: toolInput };
      default:
        return { behavior: "deny", message: "User rejected this tool call" };
    }
  }

  private ensureAgent(): Promise<string> {
    if (!this.agentIdPromise) {
      this.agentIdPromise = this.resolveAgent();
      this.agentIdPromise.catch(() => {
        // Allow retry on the next session/new instead of caching the failure.
        this.agentIdPromise = null;
      });
    }
    return this.agentIdPromise;
  }

  private async resolveAgent(): Promise<string> {
    if (this.config.agentId) {
      log(`using existing agent ${this.config.agentId}`);
      return this.config.agentId;
    }
    log("creating a new Letta agent (set LETTA_AGENT_ID to reuse one)...");
    const agentId = await this.client.createAgent({
      name: "ACP agent",
      description: "Letta agent driven by an ACP client (e.g. Zed)",
      model: this.config.model,
    });
    log(
      `created agent ${agentId} — set LETTA_AGENT_ID=${agentId} to keep using it`,
    );
    return agentId;
  }
}

/** ACP prompt content blocks -> Letta multimodal message content. */
export function toLettaContent(blocks: ContentBlock[]): MessageContentItem[] {
  const content: MessageContentItem[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "image":
        if (IMAGE_MEDIA_TYPES.has(block.mimeType)) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: block.mimeType as
                | "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp",
              data: block.data,
            },
          });
        }
        break;
      case "resource_link":
        content.push({ type: "text", text: `[Referenced file: ${block.uri}]` });
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource && typeof resource.text === "string") {
          content.push({
            type: "text",
            text: `<context uri="${resource.uri}">\n${resource.text}\n</context>`,
          });
        }
        break;
      }
      default:
        // audio and future block types are not advertised in promptCapabilities
        break;
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  return content;
}

function log(message: string): void {
  // stdout carries the ACP JSON-RPC stream; all logging goes to stderr.
  console.error(`[letta-acp] ${message}`);
}
