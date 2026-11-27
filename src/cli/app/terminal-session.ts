import {
  type CanUseToolCallback,
  type CanUseToolContext,
  type CanUseToolResponse,
  createTranscriptAccumulator,
  type LettaAgentClient,
  type LettaCodeSession,
  type ListMessagesResult,
  type SDKQueueItem,
  type SessionDeviceStatus,
  type TranscriptRow,
} from "@letta-ai/letta-agent-sdk";

import {
  type AskUserQuestionReceipt,
  parseAskUserQuestionNotif,
  parseAskUserQuestionReceipt,
  prepareAskUserQuestionNotif,
} from "@/ask-user-question";
import { VALID_PERMISSION_MODES } from "@/permissions/mode";

import type { MemoryFileEntry } from "@/types/protocol_v2";

import { isRecord } from "@/utils/type-guards";

type Approval = {
  name: string;
  input: Record<string, unknown>;
  context?: CanUseToolContext;
  resolve: (answer: CanUseToolResponse) => void;
};

type Snapshot = {
  rows: readonly TranscriptRow[];
  committed: number;
  epoch: number;
  queue: readonly SDKQueueItem[];
  approvals: readonly Approval[];
  status: "connecting" | "online" | "offline";
  error?: string;
  commandOutput?: string;
  device?: SessionDeviceStatus;
  question?: AskUserQuestionReceipt;
  model?: string;
  subagents?: { id: string; description: string; status: string }[];
  tokens?: number;
  picker?: {
    kind: "agents" | "resume" | "model";
    items: { key: string; label: string; description?: string }[];
    after?: string;
  };
  memory?: { agentId: string; entries: MemoryFileEntry[] };
  activity?: string;
};

export class TerminalSession {
  private pendingAnswers = new Set<string>();
  private echoes = new Map<string, { anchor?: string; text: string }>();
  private historyMessages = new Map<
    string,
    ListMessagesResult["messages"][number]
  >();
  private transcript = createTranscriptAccumulator();
  private listeners = new Set<() => void>();
  private unsubscribeDevice?: () => void;
  private eventSeq = new Map<string, number>();
  private target?: string;
  private session?: LettaCodeSession;
  private state: Snapshot = {
    rows: [],
    committed: 0,
    epoch: 0,
    queue: [],
    approvals: [],
    status: "connecting",
  };

  constructor(
    private readonly open: (
      approve: CanUseToolCallback,
      target?: string,
    ) => LettaCodeSession,
    private readonly management?: Pick<
      LettaAgentClient,
      "agents" | "conversations"
    >,
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

  private project(rows: readonly TranscriptRow[], settled = false) {
    for (const row of rows) {
      if (row.kind === "user" && row.otid) this.echoes.delete(row.otid);
    }

    const projected = [...rows];
    for (const [otid, { anchor, text }] of this.echoes) {
      const index = projected.findIndex(
        (row) =>
          row.key === anchor || (anchor !== undefined && row.otid === anchor),
      );
      projected.splice(index + 1, 0, { key: otid, otid, kind: "user", text });
    }
    const answered = new Set(this.pendingAnswers);
    const questions: AskUserQuestionReceipt[] = [];
    for (const row of projected) {
      if (
        row.kind === "user" &&
        row.text.includes("<ask-user-question-response>")
      ) {
        for (const answer of parseAskUserQuestionNotif(row.text))
          answered.add(answer.toolCallId);
      }
      if (
        row.kind === "tool_call" &&
        row.toolName === "AskUserQuestion" &&
        row.result
      ) {
        const receipt = parseAskUserQuestionReceipt(row.result.content);
        if (receipt) questions.push(receipt);
      }
    }
    const previous = this.state;
    const reset = previous.rows
      .slice(0, previous.committed)
      .some(
        (row, index) =>
          row !== projected[index] &&
          JSON.stringify(row) !== JSON.stringify(projected[index]),
      );
    this.update({
      rows: projected,
      question: questions.find((q) => !answered.has(q.toolCallId)),
      committed:
        settled && !this.echoes.size
          ? projected.length
          : reset
            ? 0
            : previous.committed,
      epoch: previous.epoch + Number(reset),
    });
  }

  private fail(error: unknown) {
    this.update({
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private rebase(page: ListMessagesResult, prepend = false) {
    const existing = prepend ? [...this.historyMessages] : [];
    if (prepend) this.historyMessages.clear();
    for (const message of [...page.messages].reverse()) {
      const key = JSON.stringify([
        message.message_type,
        message.id,
        message.otid,
      ]);
      this.historyMessages.delete(key);
      this.historyMessages.set(key, message);
    }
    for (const [key, message] of existing)
      this.historyMessages.set(key, message);
    const rows = this.transcript.rebase([...this.historyMessages.values()], {
      order: "asc",
    });
    this.project(rows, true);
  }

  private async history(session: LettaCodeSession, before?: string) {
    if (session.conversationId !== "default")
      return session.listMessages({
        ...(before && { before }),
        limit: 50,
        order: "desc",
      });
    const page = await session.sendCommand<{
      type: "conversation_messages_list_response";
      success: boolean;
      error?: string;
      messages: ListMessagesResult["messages"];
    }>(
      {
        type: "conversation_messages_list",
        conversation_id: "default",
        query: {
          agent_id: session.agentId,
          ...(before && { before }),
          limit: 50,
          order: "desc",
        },
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
      this.target,
    );
    this.session = session;
    try {
      const ready = await session.ready();
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
      this.update({ status: "online", model: ready.model ?? undefined });
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

  private switchTarget(target: string) {
    this.eventSeq.clear();
    this.target = target;
    this.pendingAnswers.clear();
    this.echoes.clear();
    this.historyMessages.clear();
    this.transcript = createTranscriptAccumulator();
    this.update({
      rows: [],
      committed: 0,
      epoch: this.state.epoch + 1,
      picker: undefined,
      commandOutput: undefined,
      model: undefined,
      tokens: undefined,
      subagents: undefined,
    });
    void this.connect();
  }

  async answer(
    question: AskUserQuestionReceipt,
    answers?: Record<string, string>,
  ) {
    const session = this.session;
    if (
      !session ||
      this.state.question?.toolCallId !== question.toolCallId ||
      this.pendingAnswers.has(question.toolCallId)
    )
      return;
    const text = prepareAskUserQuestionNotif({
      ...question,
      type: "ask_user_question_response",
      status: answers ? "answered" : "dismissed",
      answers,
    });
    this.pendingAnswers.add(question.toolCallId);
    this.project(this.transcript.rows());
    try {
      await session.send(text, { otid: crypto.randomUUID() });
    } catch (error) {
      if (session === this.session) {
        this.pendingAnswers.delete(question.toolCallId);
        this.project(this.transcript.rows());
        this.fail(error);
      }
    }
  }

  closePicker() {
    this.update({ picker: undefined });
  }

  async select(key: string) {
    const picker = this.state.picker;
    const session = this.session;
    if (!session || !picker) return;
    if (key === "@more" && picker.after) {
      try {
        await this.loadPicker(session, picker.kind, picker.after);
      } catch (error) {
        if (session === this.session) this.fail(error);
      }
      return;
    }
    if (picker.kind !== "model") return this.switchTarget(key);
    try {
      const model = await session.updateModel({ modelId: key });
      if (session === this.session)
        this.update({
          model: model.modelHandle ?? model.modelId ?? key,
          picker: undefined,
        });
    } catch (error) {
      if (session === this.session) this.fail(error);
    }
  }

  private async loadPicker(
    session: LettaCodeSession,
    kind: "agents" | "resume" | "model",
    after?: string,
  ) {
    let items: { key: string; label: string; description?: string }[];
    if (kind === "model") {
      const catalog = await session.listModels();
      const handles =
        catalog.availableHandles && new Set(catalog.availableHandles);
      items = catalog.entries
        .filter((entry) => !handles || handles.has(entry.handle))
        .map((entry) => ({
          key: entry.id,
          label: entry.label,
          description: entry.id,
        }));
    } else {
      if (!this.management) throw new Error("Session management unavailable");
      items =
        kind === "agents"
          ? (
              await this.management.agents.list({
                limit: 30,
                after,
                order: "desc",
              })
            ).map((agent) => ({ key: agent.id, label: agent.name ?? agent.id }))
          : (
              await this.management.conversations.list({
                agentId: session.agentId ?? undefined,
                limit: 30,
                after,
                order: "desc",
              })
            ).map((conv) => ({ key: conv.id, label: conv.summary ?? conv.id }));
    }
    if (session !== this.session) return;
    const next =
      kind !== "model" && items.length === 30 ? items.at(-1)?.key : undefined;
    if (kind === "resume" && session.agentId && !after)
      items.unshift({ key: session.agentId, label: "Default conversation" });
    this.update({
      picker: {
        kind,
        items: [...(after ? (this.state.picker?.items ?? []) : []), ...items],
        after: next,
      },
    });
  }

  receiveRuntimeEvent(event: Record<string, unknown>) {
    const session = this.session;
    const scope = event.runtime;
    if (
      !session ||
      !isRecord(scope) ||
      scope.conversation_id !== session.conversationId ||
      scope.agent_id !== session.agentId ||
      typeof event.event_seq !== "number"
    )
      return;
    const type = event.type;
    if (type !== "update_subagent_state" && type !== "turn_finished") return;
    if (event.event_seq <= (this.eventSeq.get(type) ?? -1)) return;
    this.eventSeq.set(type, event.event_seq);
    if (type === "update_subagent_state" && Array.isArray(event.subagents)) {
      this.update({
        subagents: event.subagents.flatMap((item) =>
          isRecord(item) &&
          !item.silent &&
          typeof item.subagent_id === "string" &&
          typeof item.description === "string" &&
          typeof item.status === "string"
            ? [
                {
                  id: item.subagent_id,
                  description: item.description,
                  status: item.status,
                },
              ]
            : [],
        ),
      });
    }
    if (
      type === "turn_finished" &&
      isRecord(event.usage) &&
      typeof event.usage.total_tokens === "number"
    )
      this.update({ tokens: event.usage.total_tokens });
  }

  async searchFiles(query: string) {
    const session = this.session;
    if (!session) return [];
    const result = await session.sendCommand<{
      type: "search_files_response";
      files: { path: string }[];
      success: boolean;
    }>(
      {
        type: "search_files",
        query,
        max_results: 30,
        cwd: this.state.device?.workingDirectory ?? undefined,
      },
      { responseType: "search_files_response" },
    );
    return session === this.session && result.success
      ? result.files.map((file) => file.path)
      : [];
  }

  async send(text: string) {
    const session = this.session;
    if (!session || this.state.status !== "online") return;
    const otid = crypto.randomUUID();
    try {
      if (text === "/usage") {
        this.update({
          commandOutput:
            this.state.tokens === undefined
              ? "No turn usage reported by the server yet"
              : "Last turn: " + this.state.tokens + " tokens",
        });
        return;
      }
      if (text === "/skills") {
        const status = await session.getDeviceStatus();
        if (session !== this.session) return;
        const skills = status.raw.current_available_skills;
        this.update({
          commandOutput:
            Array.isArray(skills) && skills.length
              ? skills
                  .map((skill) => skill.name + " · " + skill.description)
                  .join("\n")
              : "No skills available",
        });
        return;
      }
      if (text.startsWith("/rename ")) {
        const name = text.slice(8).trim();
        if (!name || !this.management || !session.agentId)
          throw new Error("Enter a name after /rename");
        if (session.conversationId === "default" || !session.conversationId)
          await this.management.agents.update(session.agentId, { name });
        else
          await this.management.conversations.update(session.conversationId, {
            summary: name,
          });
        if (session === this.session)
          this.update({ commandOutput: "Renamed to " + name });
        return;
      }
      if (["/connect", "/mcp", "/login", "/logout"].includes(text)) {
        const cli = text.slice(1);
        this.update({
          commandOutput:
            "Run letta " + cli + " on the computer running the app server.",
        });
        return;
      }
      if (text === "/history") {
        const oldest = this.historyMessages.values().next().value?.id;
        const page = await this.history(session, oldest);
        if (session !== this.session) return;
        this.rebase(page, true);
        this.update({
          commandOutput: page.messages.length
            ? undefined
            : "Beginning of conversation",
        });
        return;
      }
      if (text === "/agents" || text === "/resume" || text === "/model") {
        await this.loadPicker(
          session,
          text === "/agents"
            ? "agents"
            : text === "/resume"
              ? "resume"
              : "model",
        );
        return;
      }
      if (text === "/new" || text === "/clear") {
        if (!session.agentId || !this.management)
          throw new Error("Select an agent first");
        const conversation = await this.management.conversations.create({
          agentId: session.agentId,
        });
        if (this.session === session) this.switchTarget(conversation.id);
        return;
      }
      if (text === "/help") {
        this.update({
          commandOutput:
            "/agents   Switch agent\n/model    Select model and reasoning tier\n/new      Start a conversation\n/resume   Switch conversation\n/memory [path]   Browse memory files\n/queue resume    Resume queued input\nEsc              Interrupt the current turn\nCtrl+C           Exit",
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
