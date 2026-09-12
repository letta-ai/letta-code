import { randomUUID } from "node:crypto";
import type { Backend } from "@/backend";
import {
  type EnqueueReceipt,
  enqueueConversationMessage,
  getLatestConversationSuperRun,
  listEnqueuedRunMessages,
  openConversationStatusStream,
} from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import type { ParsedCliArgs } from "@/cli/args";
import { normalizeConversationShorthandFlags } from "@/cli/flag-utils";
import type { SystemInitMessage } from "@/types/protocol";
import {
  EnqueuedWaitError,
  waitForEnqueuedReply,
} from "./headless-enqueue-wait";
import {
  isCloudEnvironmentSelector,
  resolveEnvironmentMaxWaitMs,
} from "./headless-environment-response";

type SendValues = ParsedCliArgs["values"];
type SendBackend = Pick<
  Backend,
  "capabilities" | "retrieveConversation" | "createConversation" | "retrieveRun"
>;

export function shouldEnqueueCloudSend(
  values: SendValues,
  cloud: boolean,
  isAgentLaunch: boolean,
): boolean {
  if (!cloud || isAgentLaunch || values["new-agent"] || values.ephemeral)
    return false;
  return Boolean(
    values.conversation ||
      values["from-agent"] ||
      values["no-wait"] ||
      values.computer !== undefined ||
      values.environment !== undefined ||
      values.env !== undefined,
  );
}

export function buildAgentSendReminder(
  sender: { agentId?: string; conversationId?: string },
  noWait: boolean,
): string {
  if (!sender.agentId) return "";
  const address = sender.conversationId
    ? `, conversation ${sender.conversationId}`
    : "";
  const instruction = !noWait
    ? "The sender will only see the final message you generate (not tool calls or reasoning). Include your answer in your final response."
    : sender.conversationId
      ? `To reply to agent ${sender.agentId}${address}, use SendAgentMessage if available. Otherwise run letta -p --agent ${sender.agentId} --conversation ${sender.conversationId} --no-wait "your reply". Ordinary assistant output is not forwarded to the sender.`
      : "Ordinary assistant output is not forwarded to the sender. No return conversation was supplied.";
  return `<system-reminder>\nThis message is from agent ${sender.agentId}${address}.\n${instruction}\n</system-reminder>\n\n`;
}

function validateAddress(
  value: string | undefined,
  kind: "agent" | "conversation",
): string | undefined {
  if (!value) return undefined;
  if (kind === "conversation" && value === "default") return value;
  const prefix = kind === "agent" ? "agent" : "conv";
  if (!new RegExp(`^${prefix}-[a-zA-Z0-9-]+$`).test(value)) {
    throw new Error(`Invalid ${kind} ID: ${JSON.stringify(value)}`);
  }
  return value;
}

function validateSendOptions(values: SendValues): void {
  if (values.resume)
    throw new Error(
      "--resume is interactive-only; use --conversation <id> in headless mode.",
    );
  const computer = values.computer ?? values.environment ?? values.env;
  if (computer !== undefined && !computer.trim())
    throw new Error("Computer selector must not be empty.");
  if (values["input-format"])
    throw new Error(
      "Cloud message delivery does not support --input-format stream-json.",
    );
  if (values.new && values.conversation)
    throw new Error("--new cannot be combined with --conversation.");
  // Enqueue runs with the receiving listener's configuration. These flags
  // cannot silently change that configuration or weaken its restrictions.
  for (const flag of [
    "tools",
    "allowedTools",
    "disallowedTools",
    "permission-mode",
    "yolo",
    "model",
    "system",
    "system-custom",
    "pre-load-skills",
    "max-turns",
    "memfs",
    "stateless",
    "personality",
    "base-tools",
    "no-skills",
    "no-bundled-skills",
    "skill-sources",
    "skills",
    "toolset",
  ] as const) {
    if (values[flag] !== undefined && values[flag] !== false) {
      throw new Error(
        `--${flag} configures local execution and is not supported when sending to an existing Cloud harness.`,
      );
    }
  }
}

export interface CloudSendDeps {
  enqueue?: typeof enqueueConversationMessage;
  openStatusStream?: typeof openConversationStatusStream;
  listRunMessages?: typeof listEnqueuedRunMessages;
  latestSuperRun?: typeof getLatestConversationSuperRun;
  writeStdout: (text: string) => Promise<void>;
  writeStderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Return undefined for execution paths this PR intentionally leaves unchanged. */
export async function tryCloudHeadlessSend(
  values: SendValues,
  prompt: string,
  backend: SendBackend,
  isAgentLaunch: boolean,
  deps: CloudSendDeps,
): Promise<number | undefined> {
  if (
    !shouldEnqueueCloudSend(
      values,
      backend.capabilities.environmentRouting,
      isAgentLaunch,
    )
  ) {
    if (values["no-wait"])
      throw new Error(
        "--no-wait requires a Cloud message destination; it is not supported for local execution or Agent process launches.",
      );
    return undefined;
  }
  const env = deps.env ?? process.env;
  const format = values["output-format"] ?? "text";
  const noWait = Boolean(values["no-wait"]);
  const started = Date.now();
  const clientMessageId = randomUUID();
  const controller = new AbortController();
  const submissionTimeout = setTimeout(
    () =>
      controller.abort(
        new Error(
          "Cloud submission timed out; inspect the conversation before resending.",
        ),
      ),
    30_000,
  );
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error("Stopped waiting; remote execution was not cancelled."),
      ),
    deps.timeoutMs ?? resolveEnvironmentMaxWaitMs(),
  );
  const interrupt = () =>
    controller.abort(
      new Error("Interrupted waiting; remote execution was not cancelled."),
    );
  process.once("SIGINT", interrupt);
  let receipt: EnqueueReceipt | undefined;
  let submissionAttempted = false;
  let agentId: string | undefined;
  let conversationId: string | undefined;
  const stderr = deps.writeStderr ?? ((text) => process.stderr.write(text));
  const writeObject = (value: object) =>
    deps.writeStdout(
      `${JSON.stringify(value, null, format === "stream-json" ? undefined : 2)}\n`,
    );
  try {
    if (!["text", "json", "stream-json"].includes(format))
      throw new Error(`Invalid output format: ${format}`);
    validateSendOptions(values);
    const explicitSender = values["from-agent"];
    const ambientSender = env.AGENT_ID || env.LETTA_AGENT_ID;
    const sender = {
      agentId: validateAddress(explicitSender || ambientSender, "agent"),
      // An explicit different sender cannot inherit this process's return conversation.
      conversationId: validateAddress(
        !explicitSender || explicitSender === ambientSender
          ? env.CONVERSATION_ID || env.LETTA_CONVERSATION_ID
          : undefined,
        "conversation",
      ),
    };
    const normalized = normalizeConversationShorthandFlags({
      specifiedConversationId: values.conversation,
      specifiedAgentId: values.agent,
    });
    agentId = validateAddress(
      normalized.specifiedAgentId ?? undefined,
      "agent",
    );
    conversationId = validateAddress(
      normalized.specifiedConversationId ?? undefined,
      "conversation",
    );
    if (
      !agentId &&
      !conversationId &&
      !values.name &&
      !explicitSender &&
      !noWait &&
      (values.computer || values.environment || values.env)
    ) {
      // Preserve the existing `--computer` shorthand for the ambient agent.
      agentId = validateAddress(ambientSender, "agent");
    }
    if (!agentId && !conversationId)
      throw new Error(
        "Choose a destination with --agent or --conversation. Ambient AGENT_ID identifies the sender.",
      );
    if (conversationId && conversationId !== "default") {
      const conversation = await backend.retrieveConversation(conversationId, {
        signal: controller.signal,
      });
      if (agentId && agentId !== conversation.agent_id)
        throw new Error(
          "The conversation does not belong to the requested agent.",
        );
      agentId = conversation.agent_id ?? undefined;
    }
    if (!agentId) throw new Error("--conversation default requires --agent.");
    if (!conversationId) {
      const conversation = await backend.createConversation(
        { agent_id: agentId, ...(sender.agentId ? { hidden: true } : {}) },
        { signal: controller.signal },
      );
      conversationId = conversation.id;
    }
    const recovery = {
      status_command: `letta messages status --agent ${agentId} --conversation ${conversationId}`,
      messages_command: `letta messages list --agent ${agentId} --conversation ${conversationId}`,
    };
    // Subscribe and receive the initial snapshot BEFORE submitting. A status
    // stream opened only after 202 can miss a fast run's exact send mapping.
    const events = noWait
      ? undefined
      : (
          await (deps.openStatusStream ?? openConversationStatusStream)(
            agentId,
            controller,
          )
        )[Symbol.asyncIterator]();
    const initial = events ? await events.next() : undefined;
    if (initial?.done)
      throw new Error(
        "Conversation status stream closed before submission; nothing was sent.",
      );
    submissionAttempted = true;
    receipt = await (deps.enqueue ?? enqueueConversationMessage)(
      {
        agentId,
        conversationId,
        clientMessageId,
        content: `${buildAgentSendReminder(sender, noWait)}${prompt}`,
        computer: isCloudEnvironmentSelector(
          values.computer ?? values.environment ?? values.env,
        )
          ? "cloud"
          : (values.computer ?? values.environment ?? values.env),
      },
      AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    );
    clearTimeout(submissionTimeout);
    if (noWait) {
      await writeObject({ ...receipt, ...recovery });
      return 0;
    }
    if (!events || !initial || initial.done)
      throw new Error("Missing conversation status subscription.");
    if (format === "stream-json") {
      const init: SystemInitMessage = {
        type: "system",
        subtype: "init",
        session_id: agentId,
        agent_id: agentId,
        conversation_id: conversationId,
        model: "",
        tools: [],
        cwd: "",
        mcp_servers: [],
        permission_mode: "",
        slash_commands: [],
        uuid: randomUUID(),
      };
      await writeObject(init);
    }
    stderr(`${JSON.stringify({ ...receipt, ...recovery })}\n`);
    const reply = await waitForEnqueuedReply({
      receipt,
      events,
      firstEvent: initial.value,
      signal: controller.signal,
      retrieveRun: (id) =>
        backend.retrieveRun(id, { signal: controller.signal }),
      listRunMessages: (id) =>
        (deps.listRunMessages ?? listEnqueuedRunMessages)(
          id,
          controller.signal,
        ),
      latestSuperRun: async () => {
        if (!conversationId || conversationId === "default") return null;
        try {
          return await (deps.latestSuperRun ?? getLatestConversationSuperRun)(
            conversationId,
            controller.signal,
          );
        } catch (error) {
          if (error instanceof ApiRequestError && error.status === 404)
            return null;
          throw error;
        }
      },
    });
    if (format === "text") await deps.writeStdout(`${reply.text}\n`);
    else
      await writeObject({
        type: "result",
        subtype: "success",
        is_error: false,
        result: reply.text,
        session_id: agentId,
        ...receipt,
        status: "completed",
        run_ids: reply.runIds,
        ...(reply.stopReason ? { stop_reason: reply.stopReason } : {}),
        duration_ms: Date.now() - started,
        duration_api_ms: 0,
        num_turns: 1,
        usage: null,
        uuid: randomUUID(),
        ...recovery,
      });
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const result = {
      type: "result",
      subtype: "error",
      is_error: true,
      error: detail,
      result: null,
      session_id: agentId ?? "",
      duration_ms: Date.now() - started,
      duration_api_ms: 0,
      num_turns: receipt ? 1 : 0,
      run_ids: error instanceof EnqueuedWaitError ? error.runIds : [],
      usage: null,
      stop_reason: "error",
      uuid: randomUUID(),
      status: receipt
        ? "wait_failed"
        : submissionAttempted &&
            !(
              error instanceof ApiRequestError &&
              error.status >= 400 &&
              error.status < 500
            )
          ? "acceptance_unknown"
          : "submission_failed",
      agent_id: agentId ?? null,
      conversation_id: conversationId ?? "",
      client_message_id: clientMessageId,
      ...(receipt ? { receipt } : {}),
      ...(agentId && conversationId
        ? {
            status_command: `letta messages status --agent ${agentId} --conversation ${conversationId}`,
            messages_command: `letta messages list --agent ${agentId} --conversation ${conversationId}`,
          }
        : {}),
      ...(error instanceof ApiRequestError
        ? { http_status: error.status }
        : {}),
    };
    if (format === "text") stderr(`${JSON.stringify(result)}\n`);
    else await writeObject(result);
    return 1;
  } finally {
    clearTimeout(timeout);
    clearTimeout(submissionTimeout);
    process.removeListener("SIGINT", interrupt);
    controller.abort();
  }
}
