import {
  type CanUseToolCallback,
  type CanUseToolContext,
  type CanUseToolResponse,
  createTranscriptAccumulator,
  type LettaCodeSession,
  type ListMessagesResult,
  type SDKQueueItem,
  type SessionDeviceStatus,
  type TranscriptRow,
} from "@letta-ai/letta-agent-sdk";

import { VALID_PERMISSION_MODES } from "@/permissions/mode";

import type { MemoryFileEntry } from "@/types/protocol_v2";

type Approval = {
  name: string;
  input: Record<string, unknown>;
  context?: CanUseToolContext;
  resolve: (answer: CanUseToolResponse) => void;
};

type Snapshot = {
  rows: readonly TranscriptRow[];
  queue: readonly SDKQueueItem[];
  approvals: readonly Approval[];
  status: "connecting" | "online" | "offline";
  error?: string;
  commandOutput?: string;
  device?: SessionDeviceStatus;
  memory?: { agentId: string; entries: MemoryFileEntry[] };
  activity?: string;
};

export class TerminalSession {
  private echoes = new Map<string, { anchor?: string; text: string }>();
  private historyMessages = new Map<
    string,
    ListMessagesResult["messages"][number]
  >();
  private transcript = createTranscriptAccumulator();
  private listeners = new Set<() => void>();
  private unsubscribeDevice?: () => void;
  private session?: LettaCodeSession;
  private state: Snapshot = {
    rows: [],
    queue: [],
    approvals: [],
    status: "connecting",
  };

  constructor(
    private readonly open: (approve: CanUseToolCallback) => LettaCodeSession,
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch };
    for (const notify of this.listeners) notify();
  }

  private project(rows: readonly TranscriptRow[]) {
    for (const row of rows) {
      if (row.kind === "user" && row.otid) this.echoes.delete(row.otid);
    }
    if (!this.echoes.size) return this.update({ rows });
    const projected = [...rows];
    for (const [otid, { anchor, text }] of this.echoes) {
      const index = projected.findIndex(
        (row) =>
          row.key === anchor || (anchor !== undefined && row.otid === anchor),
      );
      projected.splice(index + 1, 0, { key: otid, otid, kind: "user", text });
    }
    this.update({ rows: projected });
  }

  private fail(error: unknown) {
    this.update({
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private rebase(page: ListMessagesResult) {
    for (const message of [...page.messages].reverse()) {
      const key = JSON.stringify([
        message.message_type,
        message.id,
        message.otid,
      ]);
      this.historyMessages.delete(key);
      this.historyMessages.set(key, message);
    }
    const rows = this.transcript.rebase([...this.historyMessages.values()], {
      order: "asc",
    });
    this.project(rows);
  }

  private async history(session: LettaCodeSession) {
    if (session.conversationId !== "default")
      return session.listMessages({ limit: 50, order: "desc" });
    const page = await session.sendCommand<{
      type: "conversation_messages_list_response";
      success: boolean;
      error?: string;
      messages: ListMessagesResult["messages"];
    }>(
      {
        type: "conversation_messages_list",
        conversation_id: "default",
        query: { agent_id: session.agentId, limit: 50, order: "desc" },
      },
      { responseType: "conversation_messages_list_response" },
    );
    if (!page.success)
      throw new Error(page.error ?? "Could not read conversation history");
    return page;
  }

  async connect() {
    this.close();
    this.update({ status: "connecting", error: undefined });
    const session = this.open(
      (name, input, context) =>
        new Promise((resolve) => {
          if (session !== this.session)
            return resolve({ behavior: "deny", message: "Disconnected" });
          this.update({
            approvals: [
              ...this.state.approvals,
              { name, input, context, resolve },
            ],
          });
        }),
    );
    this.session = session;
    try {
      await session.ready();
      if (this.session !== session) return;
      const receiveDevice = (device: SessionDeviceStatus) => {
        if (session === this.session) this.update({ device });
      };
      this.unsubscribeDevice = session.onDeviceStatus(receiveDevice);
      void session
        .getDeviceStatus()
        .then(receiveDevice)
        .catch((error) => {
          if (session === this.session) this.fail(error);
        });
      const page = await this.history(session);
      if (this.session !== session) return;
      this.rebase(page);
      this.update({ status: "online" });
      void session.recoverPendingApprovals().catch((error) => {
        if (session === this.session) this.fail(error);
      });
      while (session === this.session) {
        let received = false;
        for await (const message of session.stream()) {
          if (session !== this.session) return;
          received = true;
          if (message.type === "queue_update")
            this.update({ queue: message.queue });
          else if (message.type === "loop_status")
            this.update({
              activity: message.activeRunIds.length
                ? "Working · Esc to interrupt"
                : undefined,
            });
          else if (message.type === "error") this.fail(message.message);
          else if (message.type === "result") {
            this.update({
              activity:
                message.stopReason === "cancelled" ? "Interrupted" : undefined,
            });
            try {
              const page = await this.history(session);
              if (session !== this.session) return;
              this.rebase(page);
            } catch (error) {
              if (session === this.session) this.fail(error);
            }
          } else this.project(this.transcript.apply(message));
        }
        if (!received) throw new Error("Connection closed");
      }
    } catch (error) {
      if (session === this.session) {
        this.close();
        this.fail(error);
      }
    }
  }

  decide(request: Approval, response: CanUseToolResponse) {
    const [first, ...rest] = this.state.approvals;
    if (first !== request) return;
    this.update({ approvals: rest });
    first.resolve(response);
  }

  async send(text: string) {
    const session = this.session;
    if (!session || this.state.status !== "online") return;
    const otid = crypto.randomUUID();
    try {
      if (text === "/help") {
        this.update({
          commandOutput:
            "/memory [path]   Browse memory files\n/queue resume    Resume queued input\nEsc              Interrupt the current turn\nCtrl+C           Exit",
        });
        return;
      }
      if (text.startsWith("/queue remove ")) {
        const index = Number(text.slice(14)) - 1;
        const item = this.state.queue[index];
        if (!item) throw new Error("Choose a displayed queue number");
        const result = await session.removeQueuedMessage(item.id);
        if (session === this.session && !result.removed)
          this.update({ commandOutput: "Message already left the queue" });
        return;
      }
      if (text === "/queue resume") {
        const result = await session.sendCommand(
          {
            type: "resume_queue",
            runtime: {
              agent_id: session.agentId,
              conversation_id: session.conversationId,
            },
          },
          { responseType: "resume_queue_response" },
        );
        if (session !== this.session) return;
        if (!result.success) throw new Error(String(result.error));
        this.update({ activity: `Resumed ${result.resumed} queued` });
        return;
      }
      if (text.startsWith("/memory ")) {
        const path = text.slice(8).trim();
        const result = await session.sendCommand(
          {
            type: "read_memory_file",
            agent_id: session.agentId,
            path,
            encoding: "utf8",
          },
          { responseType: "read_memory_file_response" },
        );
        if (session !== this.session) return;
        if (!result.success) throw new Error(String(result.error));
        this.update({ commandOutput: `${path}\n${result.content ?? ""}` });
        return;
      }
      if (text === "/memory") {
        if (!session.agentId) throw new Error("Memory requires an agent");
        const entries: MemoryFileEntry[] = [];
        const result = await session.sendCommand(
          {
            type: "list_memory",
            agent_id: session.agentId,
          },
          {
            predicate: (message) => {
              if (message.type !== "list_memory_response") return false;
              if (Array.isArray(message.entries))
                for (const entry of message.entries) entries.push(entry);
              return message.done === true || message.success === false;
            },
          },
        );
        if (session !== this.session) return;
        if (result.success === false) throw new Error(String(result.error));

        this.update({
          memory: { agentId: session.agentId, entries },
          commandOutput: undefined,
        });
        return;
      }
      const command = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text);
      if (command) {
        const result = await session.sendCommand(
          {
            type: "execute_command",
            command_id: command[1],
            args: command[2],
            runtime: {
              agent_id: session.agentId,
              conversation_id: session.conversationId,
            },
          },
          { responseType: "execute_command_response" },
        );
        if (session !== this.session) return;
        if (!result.success) throw new Error(String(result.output));
        this.update({ commandOutput: String(result.output), error: undefined });
        return;
      }
      this.echoes.set(otid, { text, anchor: this.state.rows.at(-1)?.key });
      this.update({
        commandOutput: undefined,
        error: undefined,
        activity: "Working · Esc to interrupt",
      });
      this.project(this.transcript.rows());
      await session.send(text, { otid });
    } catch (error) {
      if (session !== this.session) return;
      this.echoes.delete(otid);
      this.project(this.transcript.rows());
      this.fail(error);
    }
  }

  closeMemory() {
    this.update({ memory: undefined });
  }

  async cyclePermissionMode() {
    const session = this.session;
    const device = this.state.device;
    if (!session || !device) return;
    const index = VALID_PERMISSION_MODES.indexOf(device.permissionMode);
    const permissionMode =
      VALID_PERMISSION_MODES[(index + 1) % VALID_PERMISSION_MODES.length];
    try {
      await session.changeDeviceState({ permissionMode });
    } catch (error) {
      if (session === this.session) this.fail(error);
    }
  }

  async interrupt() {
    const session = this.session;
    try {
      if (session) {
        await session.abort();
        if (this.session === session)
          this.update({ activity: "Interrupt requested" });
      }
    } catch (error) {
      if (this.session === session) this.fail(error);
    }
  }

  close() {
    const session = this.session;
    this.session = undefined;
    for (const approval of this.state.approvals)
      approval.resolve({ behavior: "deny", message: "Disconnected" });
    this.unsubscribeDevice?.();
    this.unsubscribeDevice = undefined;
    session?.close();
    this.update({
      status: "offline",
      device: undefined,
      memory: undefined,
      approvals: [],
      queue: [],
      activity: undefined,
    });
  }
}
