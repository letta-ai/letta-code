import type { SubagentResult } from "@/agent/subagents";
import { getCurrentSubagentDepth } from "@/agent/subagents/subagent-depth";
import { SUBAGENT_DEPTH_ENV } from "@/utils/subagent-depth-env";
import {
  type ExternalToolCallListener,
  formatExternalToolCallArgs,
} from "./external-tool-call";
import { type OpenCodeEvent, OpenCodeServer } from "./opencode-server";

interface OpenCodeTurnOptions {
  prompt: string;
  parentAgentId: string;
  cwd: string;
  model?: string;
  mcpReminder?: string;
  signal?: AbortSignal;
  resumeSessionId?: string;
  onStarted?: (sessionId: string) => void;
  onToolCall?: ExternalToolCallListener;
}

interface OpenCodeMessage {
  info: {
    role: string;
    modelID?: string;
    providerID?: string;
    error?: { name: string; data?: { message?: string } };
  };
  parts: Array<{ type: string; text?: string }>;
}

interface Turn {
  completion: Promise<SubagentResult>;
  resolve: (result: SubagentResult) => void;
  startedAt: number;
  generation: number;
  onToolCall?: ExternalToolCallListener;
  seen: Set<string>;
}

interface Session {
  id: string;
  server: OpenCodeServer;
  model?: { providerID: string; modelID: string };
  mcpReminder?: string;
  active?: Turn;
  lock: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
}

const sessions = new Map<string, Session>();
const creations = new Map<string, Promise<Session>>();

export function parseOpenCodeModel(model?: string): Session["model"] {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      "OpenCode model must be provider/model, or omitted for its configured default",
    );
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withLock<T>(session: Session, work: () => Promise<T>): Promise<T> {
  const result = session.lock.then(work);
  session.lock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function dispose(session: Session, error?: string): Promise<void> {
  if (session.stopping) return session.stopping;
  clearTimeout(session.idleTimer);
  if (sessions.get(session.id) === session) sessions.delete(session.id);
  // A stopped task must not report completion while its shell children still run.
  session.stopping = session.server.close().then(() => {
    if (session.active)
      finish(session, session.active, {
        success: false,
        report: "",
        error: error ?? "OpenCode session stopped",
      });
  });
  return session.stopping;
}

function finish(
  session: Session,
  turn: Turn,
  result: Pick<SubagentResult, "success" | "report" | "error" | "model">,
): void {
  if (session.active !== turn) return;
  session.active = undefined;
  if (!session.stopping) {
    session.idleTimer = setTimeout(() => void dispose(session), 5 * 60_000);
    session.idleTimer.unref();
  }
  turn.resolve({
    agentId: `opencode_${session.id}`,
    runtimeSessionId: session.id,
    durationMs: Date.now() - turn.startedAt,
    ...result,
  });
}

function onEvent(session: Session, event: OpenCodeEvent): void {
  const turn = session.active;
  if (!turn) return;
  const part = event.properties.part;
  const sessionID = event.properties.sessionID ?? part?.sessionID;
  if (sessionID !== session.id) return;
  // Never silently approve permissions or leave a noninteractive worker waiting.
  if (event.type === "permission.asked" || event.type === "question.asked") {
    dispose(
      session,
      `OpenCode requires interactive ${event.type === "permission.asked" ? "permission approval" : "input"}; resume in OpenCode or configure a noninteractive task`,
    );
    return;
  }
  if (
    event.type === "message.part.updated" &&
    part?.type === "tool" &&
    part.callID &&
    part.tool &&
    part.state?.status !== "pending" &&
    !turn.seen.has(part.callID)
  ) {
    turn.seen.add(part.callID);
    turn.onToolCall?.({
      id: part.callID,
      name: part.tool,
      args: formatExternalToolCallArgs(part.state?.input),
    });
  }
}

async function createSession(
  options: OpenCodeTurnOptions,
  env: NodeJS.ProcessEnv,
): Promise<Session> {
  const model = parseOpenCodeModel(options.model);
  const server = new OpenCodeServer(options.cwd, {
    ...env,
    AGENT_ID: options.parentAgentId,
    LETTA_AGENT_ID: options.parentAgentId,
    LETTA_PARENT_AGENT_ID: options.parentAgentId,
    LETTA_CODE_AGENT_ROLE: "subagent",
    [SUBAGENT_DEPTH_ENV]: String(getCurrentSubagentDepth() + 1),
  });
  const abort = () =>
    void server.close(new Error("OpenCode startup cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    await server.connect(options.signal);
    const info = await server.request<{ id: string; directory: string }>(
      options.resumeSessionId
        ? `/session/${options.resumeSessionId}`
        : "/session",
      options.resumeSessionId ? undefined : {},
    );
    if (!/^ses_[a-zA-Z0-9]+$/.test(info.id))
      throw new Error("OpenCode returned an invalid session ID");
    server.setDirectory(info.directory);
    const session: Session = {
      id: info.id,
      server,
      model,
      mcpReminder: options.mcpReminder,
      lock: Promise.resolve(),
    };
    const stream = await server.events((event) => onEvent(session, event));
    sessions.set(session.id, session);
    void stream.completion.catch((error) => dispose(session, message(error)));
    return session;
  } catch (error) {
    await server.close();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

async function getSession(
  options: OpenCodeTurnOptions,
  env: NodeJS.ProcessEnv,
): Promise<Session> {
  const id = options.resumeSessionId;
  if (!id) return createSession(options, env);
  const loaded = sessions.get(id);
  if (loaded) return loaded;
  const pending = creations.get(id);
  if (pending) return pending;
  const creation = createSession(options, env).finally(() =>
    creations.delete(id),
  );
  creations.set(id, creation);
  return creation;
}

function submit(session: Session, turn: Turn, prompt: string): void {
  const generation = ++turn.generation;
  void session.server
    .request<OpenCodeMessage>(
      `/session/${session.id}/message`,
      {
        parts: [{ type: "text", text: prompt }],
        ...(session.model ? { model: session.model } : {}),
        ...(session.mcpReminder ? { system: session.mcpReminder } : {}),
      },
      true,
    )
    .then(
      (reply) =>
        withLock(session, async () => {
          if (session.stopping || turn.generation !== generation) return;
          if (reply.info.role !== "assistant")
            throw new Error("OpenCode returned no assistant result");
          const error = reply.info.error;
          finish(session, turn, {
            success: !error,
            error: error ? (error.data?.message ?? error.name) : undefined,
            report: reply.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n"),
            model:
              reply.info.providerID && reply.info.modelID
                ? `${reply.info.providerID}/${reply.info.modelID}`
                : undefined,
          });
        }),
      (error) =>
        withLock(session, async () => {
          if (!session.stopping && turn.generation === generation)
            finish(session, turn, {
              success: false,
              report: "",
              error: message(error),
            });
        }),
    )
    .catch((error) => dispose(session, message(error)));
}

function start(session: Session, options: OpenCodeTurnOptions): Turn {
  options.signal?.throwIfAborted();
  if (session.stopping) throw new Error("OpenCode session is stopping");
  if (session.active)
    throw new Error("OpenCode session already has an active turn");
  clearTimeout(session.idleTimer);
  let resolve!: Turn["resolve"];
  const completion = new Promise<SubagentResult>((done) => {
    resolve = done;
  });
  const turn: Turn = {
    completion,
    resolve,
    startedAt: Date.now(),
    generation: 0,
    seen: new Set(),
    onToolCall: options.onToolCall,
  };
  session.active = turn;
  submit(session, turn, options.prompt);
  options.onStarted?.(session.id);
  return turn;
}

export async function runOpenCodeTurn(
  options: OpenCodeTurnOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubagentResult> {
  let session: Session | undefined;
  const abort = () => {
    if (session) dispose(session, "OpenCode turn cancelled");
  };
  try {
    options.signal?.throwIfAborted();
    session = await getSession(options, env);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const current = session;
    const turn = await withLock(current, async () => start(current, options));
    return await turn.completion;
  } catch (error) {
    if (session) await dispose(session, message(error));
    return {
      agentId: options.resumeSessionId
        ? `opencode_${options.resumeSessionId}`
        : options.parentAgentId,
      report: "",
      success: false,
      error: message(error),
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function sendOpenCodeMessage(
  options: Omit<OpenCodeTurnOptions, "resumeSessionId"> & { sessionId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  mode: "steered" | "new_turn";
  completion?: Promise<SubagentResult>;
  interrupt?: () => Promise<void>;
}> {
  options.signal?.throwIfAborted();
  const session = await getSession(
    { ...options, resumeSessionId: options.sessionId },
    env,
  );
  return withLock(session, async () => {
    options.signal?.throwIfAborted();
    const active = session.active;
    if (active) {
      // Ignore the aborted request's result; the replacement owns this same task.
      active.generation++;
      try {
        await session.server.request(`/session/${session.id}/abort`, {});
        submit(session, active, options.prompt);
      } catch (error) {
        dispose(session, message(error));
        throw error;
      }
      return { mode: "steered" };
    }
    const turn = start(session, { ...options, signal: undefined });
    return {
      mode: "new_turn",
      completion: turn.completion,
      interrupt: async () => {
        if (session.active === turn)
          await dispose(session, "OpenCode turn cancelled");
      },
    };
  });
}

export async function closeOpenCodeSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map((session) => dispose(session)));
}
