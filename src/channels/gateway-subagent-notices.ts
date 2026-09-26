import type { SubagentStateUpdateMessage } from "@/types/app-server-protocol";
import { sanitizeChannelProgressCore } from "./progress-formatting";
import type { ChannelTurnSource } from "./types";

/** Explicit per-route opt-in. No wildcard accounts, agents, chats or conversations. */
export type ChannelSubagentNoticeRoute = Pick<
  ChannelTurnSource,
  "channel" | "chatId" | "threadId" | "agentId" | "conversationId"
> & { accountId: string };

export interface ChannelSubagentNoticeOptions {
  routes: readonly ChannelSubagentNoticeRoute[];
  /** Transport must recheck current outbound authorization before sending. */
  send(source: ChannelSubagentNoticeRoute, text: string): Promise<void>;
}

interface NoticeTurn {
  startedAt: number;
  routingSources: ChannelTurnSource[];
}
interface PendingNotice {
  origin: ChannelSubagentNoticeRoute;
  toolCallId: string;
  running: boolean;
  description: string;
}

export function sameSubagentNoticeRoute(
  a: ChannelTurnSource,
  b: ChannelTurnSource,
): boolean {
  return (
    !!a.accountId &&
    a.channel === b.channel &&
    a.accountId === b.accountId &&
    a.chatId === b.chatId &&
    (a.threadId ?? null) === (b.threadId ?? null) &&
    a.agentId === b.agentId &&
    a.conversationId === b.conversationId
  );
}

/** Public task labels only: flatten formatting and remove common private references.
 * This is not semantic secret detection; opt-in explicitly shares descriptions.
 */
export function sanitizeSubagentDescription(value: unknown): string {
  return (
    sanitizeChannelProgressCore(
      (typeof value === "string" ? value : "")
        .slice(0, 8192)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal OSC escape sequences from untrusted descriptions.
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal CSI escape sequences from untrusted descriptions.
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/(?:https?:\/\/|www\.)\S+/gi, "[link removed]")
        .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[email removed]")
        .replace(/(?:^|\s)(?:[~/]|[A-Z]:\\)\S+/g, " [path removed]")
        .replace(/(?:<[^>]*>|@[\w.-]+)/g, "")
        .replace(/\b(?:sk-|ghp_|github_pat_)[\w-]+/g, "[secret removed]")
        .replace(
          /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
          "[credential removed]",
        ),
    )
      .replace(/[&*_`~[\]{}\\#|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "Delegated task"
  );
}

/** Consumes registry snapshots and parent tool IDs, never child output or arguments. */
export class ChannelSubagentNotices {
  private readonly claimed = new Set<string>();
  private readonly pending = new WeakMap<
    NoticeTurn,
    Map<string, PendingNotice>
  >();
  private readonly toolCalls = new WeakMap<NoticeTurn, Set<string>>();
  private closed = false;
  private readonly batches = new Map<
    NoticeTurn,
    {
      origin: ChannelSubagentNoticeRoute;
      descriptions: string[];
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly options?: ChannelSubagentNoticeOptions) {}

  close(): void {
    this.closed = true;
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    this.batches.clear();
  }

  observeToolCall(active: NoticeTurn, toolCallId: string | undefined): void {
    if (this.closed || !this.options || !toolCallId) return;
    let ids = this.toolCalls.get(active);
    if (!ids) {
      ids = new Set();
      this.toolCalls.set(active, ids);
    }
    if (ids.size >= 4096) return;
    ids.add(toolCallId);
    // Control snapshots and data deltas can arrive in either order.
    for (const [key, notice] of this.pending.get(active) ?? []) {
      this.trySend(active, key, notice);
    }
  }

  private trySend(
    active: NoticeTurn,
    key: string,
    notice: PendingNotice,
  ): void {
    if (!notice.running || !this.toolCalls.get(active)?.has(notice.toolCallId))
      return;
    const [source] = active.routingSources;
    this.pending.get(active)?.delete(key); // Claim before transport, including failures.
    if (
      active.routingSources.length !== 1 ||
      !source ||
      !sameSubagentNoticeRoute(notice.origin, source)
    )
      return;
    const existing = this.batches.get(active);
    if (existing) {
      if (!sameSubagentNoticeRoute(existing.origin, notice.origin)) return;
      existing.descriptions.push(notice.description);
      return;
    }
    // A bounded window also batches separate control frames from parallel spawns.
    const batch = {
      origin: notice.origin,
      descriptions: [notice.description],
      timer: setTimeout(() => {
        this.batches.delete(active);
        void Promise.resolve()
          .then(async () => {
            const [current] = active.routingSources;
            if (
              this.closed ||
              active.routingSources.length !== 1 ||
              !current ||
              !sameSubagentNoticeRoute(current, batch.origin) ||
              !this.options?.routes.some((route) =>
                sameSubagentNoticeRoute(route, batch.origin),
              )
            )
              return;
            // Keep each message bounded, with one actual task description per line.
            for (let i = 0; i < batch.descriptions.length; i += 10) {
              if (
                this.closed ||
                active.routingSources.length !== 1 ||
                !active.routingSources[0] ||
                !sameSubagentNoticeRoute(
                  active.routingSources[0],
                  batch.origin,
                ) ||
                !this.options.routes.some((route) =>
                  sameSubagentNoticeRoute(route, batch.origin),
                )
              )
                return;
              const descriptions = batch.descriptions.slice(i, i + 10);
              await this.options.send(
                batch.origin,
                `**Dispatched ${descriptions.length === 1 ? "subagent" : "subagents"}**\n${descriptions.join("\n")}`,
              );
            }
          })
          .catch(() => {
            /* Best-effort, at most once. Never expose transport errors. */
          });
      }, 50),
    };
    this.batches.set(active, batch);
  }

  handle(message: SubagentStateUpdateMessage, active: NoticeTurn | null): void {
    if (this.closed || !this.options || !active) return;
    // Coalesced turns from multiple chats have no unambiguous originating route.
    const [source] = active.routingSources;
    if (active.routingSources.length !== 1 || !source?.accountId) return;
    if (
      !this.options.routes.some((route) =>
        sameSubagentNoticeRoute(route, source),
      )
    )
      return;
    if (
      message.runtime.agent_id !== source.agentId ||
      message.runtime.conversation_id !== source.conversationId
    )
      return;
    let pending = this.pending.get(active);
    if (!pending) {
      pending = new Map();
      this.pending.set(active, pending);
    }
    for (const child of message.subagents) {
      if (
        child.silent ||
        !child.tool_call_id ||
        !child.subagent_id ||
        child.parent_agent_id !== source.agentId ||
        (child.parent_conversation_id ?? "default") !== source.conversationId
      )
        continue;
      const key = JSON.stringify([
        source.agentId,
        source.conversationId,
        child.subagent_id,
      ]);
      if (child.status === "pending") {
        // Require a fresh pending observation in this active turn and correlate
        // its tool ID with the parent stream. Recovery-only running snapshots
        // are intentionally not announced. Clock skew may suppress a notice.
        if (
          !Number.isFinite(child.start_time) ||
          child.start_time < active.startedAt ||
          this.claimed.has(key) ||
          this.claimed.size >= 4096
        )
          continue;
        // Fail closed at the cap, rather than evicting replay dedupe keys.
        this.claimed.add(key);
        pending.set(key, {
          origin: {
            channel: source.channel,
            accountId: source.accountId,
            chatId: source.chatId,
            threadId: source.threadId ?? null,
            agentId: source.agentId,
            conversationId: source.conversationId,
          },
          toolCallId: child.tool_call_id,
          running: false,
          description: sanitizeSubagentDescription(child.description),
        });
        continue;
      }
      const notice = pending.get(key);
      if (!notice || notice.toolCallId !== child.tool_call_id) continue;
      if (child.status === "running") {
        // URL projection can mark a fork running before spawn. Require the
        // explicit process event marker; older listeners fail closed.
        if (
          typeof child.spawned_at !== "number" ||
          !Number.isFinite(child.spawned_at) ||
          child.spawned_at < child.start_time
        )
          continue;
        notice.running = true;
        this.trySend(active, key, notice);
      } else if (child.status === "completed" || child.status === "error") {
        pending.delete(key); // No confirmed attributable spawn, no notice. No completion notices.
      }
    }
  }
}
