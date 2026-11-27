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
  echoes: ReadonlyMap<string, string>;
  queue: readonly SDKQueueItem[];
  approvals: readonly Approval[];
  status: "connecting" | "online" | "offline";
  error?: string;
  memory?: string;
};

export class TerminalSession {
  private transcript = createTranscriptAccumulator();
  private listeners = new Set<() => void>();
  private session?: LettaCodeSession;
  private state: Snapshot = {
    rows: [],
    echoes: new Map(),
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
    const echoes = new Map(this.state.echoes);
    for (const row of rows)
      if (row.kind === "user" && row.otid) echoes.delete(row.otid);
    this.update({ rows, echoes });
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
          else if (message.type === "error") this.fail(message.message);
          else this.project(this.transcript.apply(message));
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
      this.update({
        echoes: new Map(this.state.echoes).set(otid, text),
        memory: undefined,
      });
      await session.send(text, { otid });
    } catch (error) {
      if (session !== this.session) return;
      const echoes = new Map(this.state.echoes);
      echoes.delete(otid);
      this.update({ echoes });
      this.fail(error);
    }
  }

  async interrupt() {
    const session = this.session;
    try {
      await session?.abort();
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
    this.update({ status: "offline", approvals: [], queue: [] });
  }
}
