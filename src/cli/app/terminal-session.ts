import {
  type CanUseToolCallback,
  type CanUseToolContext,
  type CanUseToolResponse,
  createTranscriptAccumulator,
  type LettaCodeSession,
  type SDKQueueItem,
  type TranscriptRow,
} from "@letta-ai/letta-agent-sdk";

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
  memory?: string;
  activity?: string;
};

export class TerminalSession {
  private echoes = new Map<string, { anchor?: string; text: string }>();
  private transcript = createTranscriptAccumulator();
  private listeners = new Set<() => void>();
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
      const index = projected.findIndex((row) => row.key === anchor);
      projected.splice(index + 1, 0, { key: otid, otid, kind: "user", text });
    }
    this.update({ rows: projected });
  }

  private fail(error: unknown) {
    this.update({
      error: error instanceof Error ? error.message : String(error),
    });
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
      const page = await session.bootstrapState();
      if (this.session !== session) return;
      this.project(this.transcript.rebase(page));
      this.update({ status: "online" });
      if (page.hasPendingApproval)
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
              const page = await session.listMessages({ limit: 50 });
              if (session !== this.session) return;
              this.project(this.transcript.rebase(page));
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

  decide(allow: boolean) {
    const [first, ...rest] = this.state.approvals;
    if (!first) return;
    this.update({ approvals: rest });
    first.resolve(
      allow
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Denied by user" },
    );
  }

  async send(text: string) {
    const session = this.session;
    if (!session || this.state.status !== "online") return;
    const otid = crypto.randomUUID();
    try {
      if (text === "/help") {
        this.update({
          memory:
            "/memory [path]   Browse memory files\n/queue resume    Resume queued input\nEsc              Interrupt the current turn\nCtrl+C           Exit",
        });
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
        this.update({ memory: `${path}\n${result.content ?? ""}` });
        return;
      }
      if (text === "/memory") {
        const paths: string[] = [];
        const result = await session.sendCommand(
          {
            type: "list_memory",
            agent_id: session.agentId,
          },
          {
            predicate: (message) => {
              if (message.type !== "list_memory_response") return false;
              if (Array.isArray(message.entries))
                for (const entry of message.entries)
                  paths.push(entry.relative_path);
              return message.done === true || message.success === false;
            },
          },
        );
        if (session !== this.session) return;
        if (result.success === false) throw new Error(String(result.error));

        this.update({
          memory: paths.join("\n") || "No memory files",
        });
        return;
      }
      if (/^\/[a-z][\w-]*(?:\s|$)/i.test(text)) {
        this.update({
          error: "Unknown command. Type /help to list terminal commands.",
        });
        return;
      }
      this.echoes.set(otid, { text, anchor: this.state.rows.at(-1)?.key });
      this.update({
        memory: undefined,
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
    session?.close();
    this.update({
      status: "offline",
      approvals: [],
      queue: [],
      activity: undefined,
    });
  }
}
