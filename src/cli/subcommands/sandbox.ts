import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isLocalAgentId } from "@/agent/agent-id";
import { isLettaCloud } from "@/agent/memory-filesystem";
import { getClient } from "@/backend/api/client";
import {
  createSandboxDesktopSession,
  createSandboxPublicExposure,
  downloadFileFromSandbox,
  ensureConversationSandbox,
  uploadFileToSandbox,
} from "@/backend/api/sandbox-files";
import { buildDesktopViewerUrl } from "@/cli/helpers/app-urls";
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";
import { type SessionRef, settingsManager } from "@/settings-manager";

interface SandboxSubcommandDeps {
  createDesktopSession?: typeof createSandboxDesktopSession;
  createPublicExposure?: typeof createSandboxPublicExposure;
  downloadFile?: typeof downloadFileFromSandbox;
  ensureSandbox?: typeof ensureConversationSandbox;
  getLastSession?: () => SessionRef | null;
  initializeSettings?: () => Promise<void>;
  isCloud?: () => Promise<boolean>;
  isManagedRuntime?: () => boolean;
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
  "expires-in": { type: "string" },
  "extend-by": { type: "string" },
} as const;

const MIN_EXPOSURE_DURATION_SECONDS = 60;
const MAX_EXPOSURE_DURATION_SECONDS = 24 * 60 * 60;

function printUsage(): void {
  console.log(
    `
Usage:
  letta sandbox upload <local-path>
  letta sandbox download <sandbox-path> [--to <local-path>]
  letta sandbox desktop-link
  letta sandbox expose <port> --expires-in <duration>
  letta sandbox expose <port> --extend-by <duration>

Target another conversation (upload, download, or desktop-link):
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
  - desktop-link prints a browser viewer URL that opens the sandbox's live
    desktop in a browser tab with no sign-in. Anyone with the link can view
    and control the desktop until expiresAt (about one hour); share it only
    with the person who needs it.
  - expose works only inside a Letta-managed sandbox. --expires-in creates or
    renews the URL to the requested remaining lifetime; --extend-by adds time
    to the current deadline while preserving the URL and port. Durations use
    whole seconds, minutes, or hours (for example 30m, 2h, or 24h), from 1m to
    24h. Anyone with the link can access the app; share it carefully.
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

function parseExposureDuration(value: string, option: string): number {
  const match = /^([1-9]\d*)(s|m|h)$/.exec(value.trim().toLowerCase());
  if (!match) {
    throw new Error(`${option} must be a duration such as 30m, 2h, or 24h`);
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1;
  const seconds = amount * multiplier;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < MIN_EXPOSURE_DURATION_SECONDS ||
    seconds > MAX_EXPOSURE_DURATION_SECONDS
  ) {
    throw new Error(`${option} must be between 1m and 24h`);
  }
  return seconds;
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
    throw new Error("The sandbox command requires a Letta Cloud agent");
  }
  if (
    !session.conversationId ||
    session.conversationId === "default" ||
    session.conversationId === "new"
  ) {
    throw new Error("The sandbox command requires an active conversation");
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
    throw new Error("The sandbox command requires a Letta Cloud agent");
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

  const [action, path, ...extraPositionals] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }
  if (action === "desktop-link" && path !== undefined) {
    console.error("Error: desktop-link takes no path argument");
    printUsage();
    return 1;
  }
  if (action === "expose") {
    if (
      path === undefined ||
      extraPositionals.length > 0 ||
      parsed.values.to !== undefined
    ) {
      console.error("Error: expose requires exactly one port argument");
      printUsage();
      return 1;
    }
    const hasExpiry = parsed.values["expires-in"] !== undefined;
    const hasExtension = parsed.values["extend-by"] !== undefined;
    if (hasExpiry === hasExtension) {
      console.error(
        "Error: expose requires exactly one of --expires-in or --extend-by",
      );
      printUsage();
      return 1;
    }
    if (
      parsed.values.agent !== undefined ||
      parsed.values.conversation !== undefined
    ) {
      console.error("Error: expose does not accept target flags");
      printUsage();
      return 1;
    }
  }
  if (
    action !== "expose" &&
    (parsed.values["expires-in"] !== undefined ||
      parsed.values["extend-by"] !== undefined)
  ) {
    console.error("Error: expiry flags are only valid with expose");
    printUsage();
    return 1;
  }
  if (
    action !== "desktop-link" &&
    action !== "expose" &&
    ((action !== "upload" && action !== "download") || !path)
  ) {
    console.error(
      "Error: expected upload or download with a file path, desktop-link, or expose with a port",
    );
    printUsage();
    return 1;
  }

  try {
    await (deps.initializeSettings ?? initializeSandboxSettings)();
    if (!(await (deps.isCloud ?? isLettaCloud)())) {
      throw new Error("The sandbox command is only available on Letta Cloud");
    }
    if (action === "expose") {
      if (!(deps.isManagedRuntime ?? isManagedCloudRuntime)()) {
        throw new Error(
          "The expose command is only available inside a Letta-managed sandbox",
        );
      }
      const port = Number(path);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error("Port must be an integer between 1024 and 65535");
      }
      const expiry =
        parsed.values["expires-in"] !== undefined
          ? {
              expiresInSeconds: parseExposureDuration(
                parsed.values["expires-in"],
                "--expires-in",
              ),
            }
          : {
              extendBySeconds: parseExposureDuration(
                parsed.values["extend-by"] ?? "",
                "--extend-by",
              ),
            };
      const exposure = await (
        deps.createPublicExposure ?? createSandboxPublicExposure
      )(port, expiry);
      console.log(JSON.stringify(exposure, null, 2));
      return 0;
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
          "The server returned a sandbox for a different conversation; nothing was done",
        );
      }
      return sandbox;
    };
    const targetOutput = explicitTarget ? session : {};

    if (action === "desktop-link") {
      const sandbox = await ensureSandbox();
      const desktop = await (
        deps.createDesktopSession ?? createSandboxDesktopSession
      )(sandbox.sandboxId);
      console.log(
        JSON.stringify(
          {
            url:
              desktop.viewerUrl ??
              buildDesktopViewerUrl(desktop.url, desktop.expiresAt),
            expiresAt: desktop.expiresAt,
            ...targetOutput,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (path === undefined) throw new Error("Missing file path");
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
