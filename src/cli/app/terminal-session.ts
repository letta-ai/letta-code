import {
  type CanUseToolCallback,
  type CanUseToolResponse,
  createTranscriptAccumulator,
  type LettaAgentClient,
  type LettaCodeModelEntry,
  type LettaCodeSession,
  type ListMessagesResult,
  type MessageContentItem,
  type SessionDeviceStatus,
  type TranscriptRow,
} from "@letta-ai/letta-agent-sdk";
import { isLocalAgentId } from "@/agent/agent-id";
import { getModelDisplayName } from "@/agent/model";
import {
  type AskUserQuestionReceipt,
  prepareAskUserQuestionNotif,
} from "@/ask-user-question";
import { INTERRUPT_MESSAGE } from "@/cli/app/constants";
import { queuedDraft } from "@/cli/app/queued-draft";
import { sessionConversations } from "@/cli/app/session-conversations";
import { sessionSubagents } from "@/cli/app/session-subagents";
import { isSessionSkillCommand } from "@/cli/app/terminal-commands";
import {
  projectTranscript,
  streamBytes,
  TerminalRowLifecycle,
} from "@/cli/app/terminal-row-lifecycle";
import type { Approval, Skill, Snapshot } from "@/cli/app/terminal-snapshot";
import { createSubagentGroupItem } from "@/cli/helpers/subagent-aggregation";
import type { PermissionMode } from "@/permissions/mode";
import type {
  PickerCollection,
  PickerPageResponse,
} from "@/types/agent-picker";
import type { MemoryFileEntry } from "@/types/protocol_v2";
import { isRecord } from "@/utils/type-guards";

export class TerminalSession {
  private pendingAnswers = new Set<string>();
  private echoes = new Map<string, { anchor?: string; text: string }>();
  private historyMessages = new Map<
    string,
    ListMessagesResult["messages"][number]
  >();
  readonly approvedArguments = new Map<string, Record<string, unknown>>();
  rowLifecycle = new TerminalRowLifecycle();
  private transcript = createTranscriptAccumulator();
  private listeners = new Set<() => void>();
  private unsubscribeDevice?: () => void;
  private eventSeq = new Map<string, number>();
  private target?: string;
  private session?: LettaCodeSession;
  private state: Snapshot = {
    rows: [],
    notices: [],
    turnActive: false,
    turnBytes: 0,
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
    private readonly logout?: () => Promise<string>,
    private readonly catalog?: LettaCodeModelEntry[],
  ) {}

  get modelDisplayName() {
    const model = this.state.model;
    if (!model) return undefined;
    return (
      getModelDisplayName(model) ??
      this.catalog?.find(
        (entry) => entry.handle === model || entry.id === model,
      )?.label ??
      model
    );
  }

  readonly conversations = sessionConversations(() => {
    if (!this.session) throw new Error("Session disconnected");
    return this.session;
  });
  get conversationId() {
    return this.session?.conversationId ?? "default";
  }
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
    this.update(
      projectTranscript(
        rows,
        settled,
        this.state,
        this.rowLifecycle,
        this.echoes,
        this.pendingAnswers,
        this.approvedArguments,
      ),
    );
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
          if (context?.toolCallId)
            this.approvedArguments.set(context.toolCallId, input);
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
      if (this.management && ready.agentId)
        void this.management.agents
          .retrieve(ready.agentId)
          .then((agent) => {
            if (this.session === session)
              this.update({ agentName: agent.name });
          })
          .catch(() => {});
      const receiveDevice = (device: SessionDeviceStatus) => {
        if (session === this.session)
          this.update({
            device,
            ...(device.isProcessing && !this.state.turnActive
              ? { turnActive: true, turnBytes: 0 }
              : {}),
          });
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
      this.update({
        status: "online",
        resumedHistory: page.messages.length > 0,
        model: ready.model ?? undefined,
        agentId: ready.agentId,
      });
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
            this.update(
              message.activeRunIds.length ? { turnActive: true } : {},
            );
          else if (message.type === "error") this.fail(message.message);
          else if (message.type === "result") {
            this.project(this.transcript.rows(), true);
            const interrupted =
              message.stopReason === "interrupted" ||
              message.stopReason === "cancelled";
            if (interrupted) this.notice(INTERRUPT_MESSAGE);
            this.update({
              activity: undefined,
              turnActive: false,
              turnBytes: 0,
            });
            try {
              const page = await this.history(session);
              if (session !== this.session) return;
              this.rebase(page);
            } catch (error) {
              if (session === this.session) this.fail(error);
            }
          } else {
            const previous = this.transcript.rows();
            const after = this.transcript.apply(message);
            if (
              message.type === "tool_result" &&
              previous !== after &&
              !previous.some(
                (row) =>
                  row.kind === "tool_call" &&
                  row.toolCallId === message.toolCallId &&
                  row.status === "complete",
              )
            )
              this.update({ turnBytes: 0 });
            const bytes = previous === after ? undefined : streamBytes(message);
            if (bytes !== undefined)
              this.update({
                turnActive: true,
                turnBytes: this.state.turnBytes + bytes,
              });
            this.project(after);
          }
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

  private notice(text: string, input?: string) {
    this.update({
      notices: [
        ...this.state.notices,
        { id: crypto.randomUUID(), index: this.state.committed, input, text },
      ],
    });
  }

  private switchTarget(target: string) {
    this.approvedArguments.clear();
    this.rowLifecycle = new TerminalRowLifecycle();
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
      notices: [],
      picker: undefined,
      skills: undefined,
      commandOutput: undefined,
      model: undefined,
      agentName: undefined,
      agentId: undefined,
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

  closeHelp() {
    this.update({ help: undefined });
  }

  closeLogin() {
    this.update({ login: false });
  }

  closePicker() {
    this.update({ picker: undefined });
  }

  async select(key: string) {
    const picker = this.state.picker;
    const session = this.session;
    if (!session || !picker) return;
    if (picker.kind !== "model")
      return this.switchTarget(
        key === "default" && session.agentId ? session.agentId : key,
      );
    try {
      const model = await session.updateModel(
        key.includes("/") ? { modelHandle: key } : { modelId: key },
      );
      if (session === this.session)
        this.update({
          model: model.modelHandle ?? model.modelId ?? key,
          picker: undefined,
        });
    } catch (error) {
      if (session === this.session) this.fail(error);
    }
  }

  deletePickerAgent = async (id: string) => {
    if (!this.management) throw new Error("Session management unavailable");
    await this.management.agents.delete(id);
  };
  unpinPickerAgent = async (id: string) => {
    if (!this.session) throw new Error("App server disconnected");
    const result = await this.session.sendCommand(
      { type: "agent_picker_unpin", agent_id: id },
      { responseType: "agent_picker_unpin_response", timeoutMs: 5000 },
    );
    if (!result.success)
      throw new Error(String(result.error ?? "Could not unpin agent"));
  };
  listAgentCollection = async (
    collection: PickerCollection,
    after?: string | null,
    query?: string,
  ) => {
    const session = this.session;
    if (!session) throw new Error("App server disconnected");
    const result = await session.sendCommand<PickerPageResponse>(
      {
        type: "agent_picker_page",
        collection,
        after: after ?? undefined,
        query,
      },
      { responseType: "agent_picker_page_response", timeoutMs: 5000 },
    );
    if (!result.success)
      throw new Error(result.error ?? "Agent listing unavailable");
    return {
      agents: result.agents ?? [],
      nextCursor: result.nextCursor ?? null,
    };
  };
  createPickerAgent = async (name: string, mode: "local" | "api") => {
    const session = this.session;
    if (!session || !this.management) return;
    try {
      if (
        session.agentId &&
        (mode === "local") !== isLocalAgentId(session.agentId)
      )
        throw new Error("Select the backend connected to this app server.");
      const result = await session.sendCommand(
        {
          type: "agent_create",
          body: { name, tags: ["origin:letta-code", "git-memory-enabled"] },
        },
        { responseType: "agent_create_response" },
      );
      if (
        !result.success ||
        !isRecord(result.agent) ||
        typeof result.agent.id !== "string"
      )
        throw new Error(String(result.error ?? "Agent creation failed"));
      if (this.session === session) this.switchTarget(result.agent.id);
    } catch (error) {
      if (this.session === session) {
        this.closePicker();
        this.fail(error);
      }
    }
  };
  listAgents = async (after?: string | null, query?: string) => {
    if (!this.management) throw new Error("Session management unavailable");
    const agents = await this.management.agents.list({
      limit: 20,
      after: after ?? undefined,
      query,
      order: "desc",
      orderBy: "lastRunCompletion",
    });
    return {
      agents: agents.map(
        ({ id, name, description, model, last_run_completion }) => ({
          id,
          name,
          description,
          model,
          last_run_completion,
        }),
      ),
      nextCursor: agents.length === 20 ? (agents.at(-1)?.id ?? null) : null,
    };
  };

  private async loadPicker(
    session: LettaCodeSession,
    kind: "agents" | "resume" | "model",
  ) {
    if (kind === "model") {
      const catalog = await session.listModels();
      if (session === this.session)
        this.update({
          picker: {
            kind,
            items: [],
            models: catalog.entries,
            handles: catalog.availableHandles,
            aliases: catalog.byokProviderAliases,
          },
        });
      return;
    }
    this.update({ picker: { kind, items: [] } });
  }

  receiveRuntimeEvent(event: Record<string, unknown>) {
    const session = this.session;
    if (event.type === "skills_updated" && this.state.skills)
      void this.send("/skills");
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
    if (
      type !== "update_subagent_state" &&
      type !== "turn_finished" &&
      type !== "update_queue"
    )
      return;
    if (event.event_seq <= (this.eventSeq.get(type) ?? -1)) return;
    this.eventSeq.set(type, event.event_seq);
    if (type === "update_queue" && Array.isArray(event.queue))
      this.update({
        pausedQueueIds: event.queue.flatMap((item) =>
          isRecord(item) && item.paused === true && typeof item.id === "string"
            ? [item.id]
            : [],
        ),
      });
    if (type === "update_subagent_state" && Array.isArray(event.subagents)) {
      const completedIds = new Set(
        this.state.notices.flatMap(
          (notice) => notice.group?.agents.map((agent) => agent.id) ?? [],
        ),
      );
      const agents = sessionSubagents(event.subagents).filter(
        (agent) => !completedIds.has(agent.id),
      );
      if (
        agents.length &&
        agents.every(
          (agent) => agent.status === "completed" || agent.status === "error",
        )
      ) {
        const group = createSubagentGroupItem(agents);
        this.update({
          subagents: [],
          notices: [
            ...this.state.notices,
            {
              id: group.id,
              group,
              toolCallIds: agents.flatMap((agent) =>
                agent.toolCallId ? [agent.toolCallId] : [],
              ),
              text: "",
              index: this.state.committed,
            },
          ],
        });
      } else this.update({ subagents: agents });
    }
    if (
      type === "turn_finished" &&
      isRecord(event.usage) &&
      typeof event.usage.total_tokens === "number"
    )
      this.update({ tokens: event.usage.total_tokens });
  }

  closeSkills() {
    this.update({ skills: undefined });
  }

  async toggleSkill(path: string) {
    const session = this.session;
    const skill = this.state.skills?.find((item) => item.path === path);
    if (!session || !skill || skill.fixed) return;
    try {
      const command = skill.enabled
        ? { type: "skill_disable", name: skill.name }
        : { type: "skill_enable", skill_path: skill.path };
      const result = await session.sendCommand(command, {
        responseType: command.type + "_response",
      });
      if (session !== this.session || !this.state.skills) return;
      if (!result.success) throw new Error(String(result.error));
      this.update({
        skills: [
          ...this.state.skills.filter((item) => item.path !== path),
          { ...skill, enabled: !skill.enabled },
        ],
      });
      await this.send("/skills");
    } catch (error) {
      if (session === this.session) this.fail(error);
    }
  }

  get queuedInput() {
    const item = this.state.queue.findLast((entry) => entry.source === "user");
    if (!item) return undefined;
    const restore = queuedDraft(item.content);
    return restore ? { item, restore } : undefined;
  }
  private recalling?: string;
  async recallQueued() {
    const session = this.session;
    const queued = this.queuedInput;
    if (!session || !queued || this.recalling) return "";
    const { item, restore } = queued;
    this.recalling = item.id;
    try {
      const result = await session.removeQueuedMessage(item.id);
      if (!result.removed || session !== this.session) return "";
      this.update({
        queue: this.state.queue.filter((entry) => entry.id !== item.id),
      });
      return restore();
    } catch (error) {
      if (session === this.session) this.fail(error);
      return "";
    } finally {
      this.recalling = undefined;
    }
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

  async send(text: string, content?: MessageContentItem[]) {
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
        if (
          Array.isArray(status.raw?.supported_commands) &&
          !status.raw.supported_commands.includes("skills")
        ) {
          const available = status.raw.current_available_skills;
          const skills = (Array.isArray(available) ? available : []).flatMap(
            (skill: unknown) => {
              if (
                !isRecord(skill) ||
                typeof skill.name !== "string" ||
                typeof skill.path !== "string"
              )
                return [];
              const path = skill.path.replace(/[\\/]SKILL\.md$/i, "");
              const name = path.split(/[\\/]/).at(-1) || skill.name;
              const known = this.state.skills?.find(
                (entry) => entry.path === path,
              );
              return {
                path,
                name,
                description:
                  typeof skill.description === "string"
                    ? skill.description
                    : "",
                label: skill.name,
                enabled: known?.enabled ?? skill.source === "global",
              };
            },
          );
          this.update({ skills });
          return;
        }
        const result = await session.sendCommand(
          {
            type: "execute_command",
            command_id: "skills",
            runtime: {
              agent_id: session.agentId,
              conversation_id: session.conversationId,
            },
          },
          { responseType: "execute_command_response" },
        );
        if (session !== this.session) return;
        if (!result.success) throw new Error(String(result.output));
        const entries: Skill[] = JSON.parse(String(result.output));
        const retained =
          this.state.skills?.filter(
            (old) =>
              !old.enabled && !entries.some((skill) => skill.path === old.path),
          ) ?? [];
        this.update({ skills: [...entries, ...retained], error: undefined });
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
      if (text === "/login" || text === "/logout") {
        if (!this.logout) {
          this.update({
            commandOutput:
              "Open an interactive letta terminal on the app-server host and run " +
              text +
              " there.",
          });
          return;
        }
        if (text === "/login") {
          this.update({ login: true });
          return;
        }
        if (this.state.device?.isProcessing || this.state.approvals.length)
          throw new Error("Finish the current turn before signing out.");
        const output = await this.logout();
        if (session === this.session) this.update({ commandOutput: output });
        return;
      }
      if (text === "/connect" || text === "/mcp") {
        this.update({
          commandOutput:
            "Run letta " +
            text.slice(1) +
            " --help on the computer running the app server.",
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
        this.update({ help: true });
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
        this.update({ commandOutput: "Opening memory viewer..." });
        const entries: MemoryFileEntry[] = [];
        const result = await session.sendCommand(
          {
            type: "list_memory",
            include_frontmatter: true,
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
          epoch: this.state.epoch + 1,
          memory: {
            agentId: session.agentId,
            conversationId: session.conversationId ?? undefined,
            entries,
          },
          commandOutput: undefined,
        });
        return;
      }
      const command = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text);
      if (
        command &&
        !isSessionSkillCommand(command[1] ?? "", this.state.device?.raw)
      ) {
        if (
          ["reflection", "clear-messages", "set-max-context"].includes(
            command[1] ?? "",
          )
        )
          throw new Error("Unknown command: " + command[1]);
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
      if (!this.state.turnActive)
        this.echoes.set(otid, { text, anchor: this.state.rows.at(-1)?.key });
      this.update({
        commandOutput: undefined,
        error: undefined,
        turnActive: true,
        activity: "Working · Esc to interrupt",
      });
      this.project(this.transcript.rows());
      await session.send(content ?? text, { otid });
    } catch (error) {
      if (session !== this.session) return;
      this.echoes.delete(otid);
      this.project(this.transcript.rows());
      this.update({
        commandOutput: undefined,
        ...(this.state.activity?.startsWith("Working") &&
        !this.state.device?.isProcessing
          ? { turnActive: false, activity: undefined }
          : {}),
      });
      this.fail(error);
    }
  }

  closeMemory() {
    this.notice("Memory viewer dismissed", "/memory");
    this.update({ memory: undefined, epoch: this.state.epoch + 1 });
  }

  async setPermissionMode(permissionMode: PermissionMode) {
    const session = this.session;
    if (!session) return;
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
      turnActive: false,
      turnBytes: 0,
      picker: undefined,
      skills: undefined,
      question: undefined,
      login: false,
      subagents: undefined,
      device: undefined,
      memory: undefined,
      approvals: [],
      pausedQueueIds: undefined,
      queue: [],
      activity: undefined,
    });
  }
}
