import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isLocalAgentId } from "@/agent/agent-id";
import { isLettaCloud } from "@/agent/memory-filesystem";
import { getClient } from "@/backend/api/client";
import {
  downloadFileFromSandbox,
  ensureConversationSandbox,
  uploadFileToSandbox,
} from "@/backend/api/sandbox-files";
import { type SessionRef, settingsManager } from "@/settings-manager";

interface SandboxSubcommandDeps {
  downloadFile?: typeof downloadFileFromSandbox;
  ensureSandbox?: typeof ensureConversationSandbox;
  getLastSession?: () => SessionRef | null;
  initializeSettings?: () => Promise<void>;
  isCloud?: () => Promise<boolean>;
  retrieveConversation?: (id: string) => Promise<{ agent_id: string | null }>;
  readLocalFile?: (path: string) => Promise<Buffer>;
  statLocalPath?: (path: string) => Promise<{ isFile(): boolean }>;
  uploadFile?: typeof uploadFileToSandbox;
  writeLocalFile?: (path: string, data: Uint8Array) => Promise<void>;
}

const SANDBOX_OPTIONS = {
  help: { type: "boolean", short: "h" },
  to: { type: "string" },
  conversation: { type: "string" },
  agent: { type: "string" },
} as const;

function printUsage(): void {
  console.log(
    `
Usage:
  letta sandbox upload <local-path>
  letta sandbox download <sandbox-path> [--to <local-path>]

Target another conversation (upload or download):
  letta sandbox upload <local-path> --conversation <conv-id>
  letta sandbox upload <local-path> --agent <agent-id>

Notes:
  - Without target flags, uses the active Letta Cloud conversation.
  - --conversation resolves the owning agent; --agent, if given, must match.
  - --agent alone selects that agent's main/default sandbox.
  - --conversation default is also supported and requires explicit --agent.
  - Target flags override shell/session context without changing it.
  - Run upload on the computer containing the local file, including a remote subagent.
  - Uploads are stored under /root/downloads in the conversation sandbox.
  - Downloads are limited to files under /root/downloads.
  - Output is JSON only.
`.trim(),
  );
}

function parseSandboxArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: SANDBOX_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function getEnvironmentSession(env: NodeJS.ProcessEnv): SessionRef | null {
  const agentId = (env.LETTA_AGENT_ID || env.AGENT_ID || "").trim();
  const conversationId = (
    env.LETTA_CONVERSATION_ID ||
    env.CONVERSATION_ID ||
    ""
  ).trim();
  if (!agentId && !conversationId) return null;
  if (!agentId || !conversationId) {
    throw new Error(
      "Both agent and conversation context are required when either is set",
    );
  }
  return { agentId, conversationId };
}

export function resolveSandboxSession(
  env: NodeJS.ProcessEnv,
  fallback: SessionRef | null,
): SessionRef {
  const session = getEnvironmentSession(env) ?? fallback;
  if (!session) {
    throw new Error("No active agent conversation found");
  }
  if (isLocalAgentId(session.agentId)) {
    throw new Error("Sandbox file transfer requires a Letta Cloud agent");
  }
  if (
    !session.conversationId ||
    session.conversationId === "default" ||
    session.conversationId === "new"
  ) {
    throw new Error("Sandbox file transfer requires an active conversation");
  }
  return session;
}

export async function resolveSandboxTarget(
  target: { agent?: string; conversation?: string },
  getCurrentSession: () => SessionRef,
  retrieveConversation: (id: string) => Promise<{ agent_id: string | null }>,
): Promise<SessionRef> {
  if (target.agent === undefined && target.conversation === undefined) {
    return getCurrentSession();
  }
  const agentId = target.agent?.trim();
  const conversationId =
    target.conversation === undefined && agentId
      ? "default"
      : target.conversation?.trim();
  if (target.agent !== undefined && !agentId) {
    throw new Error("--agent must not be empty");
  }
  if (!conversationId || conversationId === "new") {
    throw new Error(
      "Specify --conversation <conv-id> or --conversation default",
    );
  }
  if (agentId && isLocalAgentId(agentId)) {
    throw new Error("Sandbox file transfer requires a Letta Cloud agent");
  }
  if (conversationId === "default") {
    if (!agentId) throw new Error("--conversation default requires --agent");
    return { agentId, conversationId };
  }
  const conversation = await retrieveConversation(conversationId);
  if (!conversation.agent_id || isLocalAgentId(conversation.agent_id)) {
    throw new Error(
      "The target conversation must belong to a Letta Cloud agent",
    );
  }
  if (agentId && agentId !== conversation.agent_id) {
    throw new Error(
      `Conversation ${conversationId} does not belong to ${agentId}`,
    );
  }
  return { agentId: conversation.agent_id, conversationId };
}

async function initializeSandboxSettings(): Promise<void> {
  await settingsManager.initialize();
  await settingsManager.loadLocalProjectSettings();
}

export async function runSandboxSubcommand(
  argv: string[],
  deps: SandboxSubcommandDeps = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseSandboxArgs>;
  try {
    parsed = parseSandboxArgs(argv);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    printUsage();
    return 1;
  }

  const [action, path] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }
  if ((action !== "upload" && action !== "download") || !path) {
    console.error("Error: expected upload or download with a file path");
    printUsage();
    return 1;
  }

  try {
    await (deps.initializeSettings ?? initializeSandboxSettings)();
    if (!(await (deps.isCloud ?? isLettaCloud)())) {
      throw new Error("Sandbox file transfer is only available on Letta Cloud");
    }
    const session = await resolveSandboxTarget(
      parsed.values,
      () =>
        resolveSandboxSession(
          process.env,
          (
            deps.getLastSession ??
            (() => settingsManager.getEffectiveLastSession())
          )(),
        ),
      deps.retrieveConversation ??
        (async (id) => (await getClient()).conversations.retrieve(id)),
    );
    const explicitTarget =
      parsed.values.conversation !== undefined ||
      parsed.values.agent !== undefined;
    const ensureSandbox = async () => {
      const sandbox = await (deps.ensureSandbox ?? ensureConversationSandbox)(
        session.agentId,
        session.conversationId,
      );
      if (
        explicitTarget &&
        (sandbox.conversationId ?? "default") !== session.conversationId
      ) {
        throw new Error(
          "The server returned a sandbox for a different conversation; no files transferred",
        );
      }
      return sandbox;
    };
    const targetOutput = explicitTarget ? session : {};

    if (action === "upload") {
      const localPath = resolve(path);
      const fileStat = await (deps.statLocalPath ?? stat)(localPath);
      if (!fileStat.isFile()) throw new Error(`${localPath} is not a file`);
      const data = await (deps.readLocalFile ?? readFile)(localPath);
      const sandbox = await ensureSandbox();
      const result = await (deps.uploadFile ?? uploadFileToSandbox)(
        sandbox.sandboxId,
        { blob: new Blob([data]), name: basename(localPath) },
      );
      console.log(JSON.stringify({ ...result, ...targetOutput }, null, 2));
      return 0;
    }

    const sandbox = await ensureSandbox();
    const data = await (deps.downloadFile ?? downloadFileFromSandbox)(
      sandbox.sandboxId,
      path,
    );
    const localPath = resolve(parsed.values.to ?? basename(path));
    await (deps.writeLocalFile ?? writeFile)(localPath, data);
    console.log(
      JSON.stringify(
        {
          path: localPath,
          sandboxPath: path,
          size: data.byteLength,
          ...targetOutput,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}
