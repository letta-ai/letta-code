import stripAnsi from "strip-ansi";
import { type ConversationUpdateBody, getBackend } from "@/backend";
import {
  splitShellSegmentsAllowCommandSubstitution,
  tokenizeShellWords,
} from "@/permissions/shell-analysis";
import { getRuntimeContext } from "@/runtime-context";
import { debugLog } from "@/utils/debug";
import { GITHUB_PR_CONVERSATIONS_ENV } from "@/utils/subagent-launch-marker";
import {
  getPullRequestParentConversationIds,
  type ParentConversationBackend,
} from "./github-pull-request-parents";

export type ShellSourceCommand = string | readonly string[];

type OutputStream = "stdout" | "stderr";

export type ConversationTagBackend = ParentConversationBackend & {
  updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
};

export interface GitHubPullRequestOutputTracker {
  append(text: string, stream: OutputStream): void;
  finish(signal?: AbortSignal): Promise<void>;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const GITHUB_PR_URL =
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d*)\/?$/i;
const GITHUB_PR_TAG_PREFIX = "github:pull-request:";
const HEREDOC_AT_LINE_END =
  /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([^\s'"`<>|&;]+))\s*$/;
const MAX_TRACKED_OUTPUT_CHARS = 30_000;

const GH_GLOBAL_FLAGS_WITH_VALUES = new Set(["--hostname", "--repo", "-R"]);
const TIMEOUT_FLAGS_WITH_VALUES = new Set([
  "--kill-after",
  "--signal",
  "-k",
  "-s",
]);
const TIMEOUT_FLAGS_WITHOUT_VALUES = new Set([
  "--foreground",
  "--preserve-status",
  "--verbose",
  "-v",
]);

function executableName(value: string): string {
  return value.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
}

function findExecutableIndex(tokens: readonly string[]): number {
  let index = 0;
  while (ENV_ASSIGNMENT.test(tokens[index] ?? "")) {
    index += 1;
  }

  if (executableName(tokens[index] ?? "") === "env") {
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      if (ENV_ASSIGNMENT.test(token)) {
        index += 1;
        continue;
      }
      if (token === "-u" || token === "--unset") {
        index += 2;
        continue;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
  }

  while (ENV_ASSIGNMENT.test(tokens[index] ?? "")) {
    index += 1;
  }
  if (tokens[index] === "command" || tokens[index] === "&") {
    index += 1;
  }
  return index;
}

function unwrapTimeoutCommand(
  tokens: readonly string[],
  executableIndex: number,
): number | undefined {
  const executable = executableName(tokens[executableIndex] ?? "");
  if (executable !== "timeout" && executable !== "gtimeout") {
    return executableIndex;
  }

  let index = executableIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      index += 1;
      break;
    }
    if (TIMEOUT_FLAGS_WITH_VALUES.has(token)) {
      index += 2;
      continue;
    }
    if (
      token.startsWith("--kill-after=") ||
      token.startsWith("--signal=") ||
      (/^-[ks].+/.test(token) && token !== "-k" && token !== "-s")
    ) {
      index += 1;
      continue;
    }
    if (TIMEOUT_FLAGS_WITHOUT_VALUES.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return undefined;
    }
    break;
  }

  // timeout requires a duration before the command it runs.
  return index + 1 < tokens.length ? index + 1 : undefined;
}

function skipGhGlobalFlags(
  tokens: readonly string[],
  startIndex: number,
): number {
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (GH_GLOBAL_FLAGS_WITH_VALUES.has(token)) {
      index += 2;
      continue;
    }
    if (
      token.startsWith("--hostname=") ||
      token.startsWith("--repo=") ||
      (token.startsWith("-R") && token.length > 2)
    ) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function tokensCreatePullRequest(tokens: readonly string[]): boolean {
  const executableIndex = unwrapTimeoutCommand(
    tokens,
    findExecutableIndex(tokens),
  );
  if (executableIndex === undefined) {
    return false;
  }
  if (executableName(tokens[executableIndex] ?? "") !== "gh") {
    return false;
  }

  const prIndex = skipGhGlobalFlags(tokens, executableIndex + 1);
  if (tokens[prIndex] !== "pr" || tokens[prIndex + 1] !== "create") {
    return false;
  }
  const createArgs = tokens.slice(prIndex + 2);
  return !createArgs.some(
    (token) => token === "--dry-run" || token === "--web" || token === "-w",
  );
}

function isShellExecutable(value: string): boolean {
  const name = executableName(value);
  return (
    /^(ba|z|a|da)?sh$/.test(name) ||
    name === "cmd" ||
    name === "cmd.exe" ||
    name.includes("powershell") ||
    name.includes("pwsh")
  );
}

function shellScriptFromCommand(tokens: readonly string[]): string | undefined {
  const executableIndex = unwrapTimeoutCommand(
    tokens,
    findExecutableIndex(tokens),
  );
  if (executableIndex === undefined) {
    return undefined;
  }
  if (!isShellExecutable(tokens[executableIndex] ?? "")) {
    return undefined;
  }

  for (let index = executableIndex + 1; index < tokens.length; index += 1) {
    const flag = (tokens[index] ?? "").toLowerCase();
    if (
      flag === "-c" ||
      flag === "-lc" ||
      flag === "/c" ||
      flag === "-command"
    ) {
      return tokens[index + 1];
    }
  }
  return undefined;
}

function commandLinesOutsideHeredocs(command: string): string[] {
  const commandLines: string[] = [];
  let delimiter: string | undefined;
  let stripLeadingTabs = false;

  for (const line of command.split(/\r\n|\n|\r/)) {
    if (delimiter) {
      const candidate = stripLeadingTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === delimiter) {
        delimiter = undefined;
        stripLeadingTabs = false;
      }
      continue;
    }

    commandLines.push(line);
    const match = line.match(HEREDOC_AT_LINE_END);
    const nextDelimiter = match?.[2] ?? match?.[3] ?? match?.[4];
    if (nextDelimiter) {
      delimiter = nextDelimiter;
      stripLeadingTabs = match?.[1] === "-";
    }
  }

  return commandLines;
}

function splitCommandForPullRequestDetection(command: string): string[] {
  const segments = splitShellSegmentsAllowCommandSubstitution(command);
  if (segments) {
    return segments;
  }

  // The permission splitter rejects file redirects. PR commands commonly
  // write a body with a heredoc first, so retry the executable lines without
  // treating Markdown inside the heredoc as shell commands.
  return commandLinesOutsideHeredocs(command).flatMap(
    (line) => splitShellSegmentsAllowCommandSubstitution(line) ?? [line],
  );
}

export function isGitHubPullRequestCreateCommand(
  command: ShellSourceCommand,
): boolean {
  if (typeof command !== "string") {
    if (tokensCreatePullRequest(command)) {
      return true;
    }
    const shellScript = shellScriptFromCommand(command);
    return shellScript ? isGitHubPullRequestCreateCommand(shellScript) : false;
  }

  const segments = splitCommandForPullRequestDetection(command);
  return segments.some((segment) =>
    tokensCreatePullRequest(tokenizeShellWords(segment)),
  );
}

function tagFromOutputLine(line: string): string | undefined {
  const match = stripAnsi(line).trim().match(GITHUB_PR_URL);
  if (!match) {
    return undefined;
  }
  const [, owner, repo, number] = match;
  if (!owner || !repo || !number) {
    return undefined;
  }
  return `${GITHUB_PR_TAG_PREFIX}${owner.toLowerCase()}:${repo.toLowerCase()}:${number}`;
}

function appendOutputTail(
  outputByStream: Record<OutputStream, string>,
  text: string,
  stream: OutputStream,
): void {
  outputByStream[stream] = `${outputByStream[stream]}${text}`.slice(
    -MAX_TRACKED_OUTPUT_CHARS,
  );
}

async function appendConversationTags(
  backend: ConversationTagBackend,
  conversationId: string,
  tags: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  try {
    await waitForTagUpdate(
      backend
        .updateConversation(
          conversationId,
          { tags_to_add: [...tags] },
          { signal },
        )
        .then(() => undefined),
      signal,
    );
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    debugLog(
      "github-pr-tracking",
      `Failed to tag conversation ${conversationId}`,
      error,
    );
  }
}

function waitForTagUpdate(
  update: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return update;
  let onAbort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return Promise.race([update, stopped]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

export function createGitHubPullRequestOutputTracker(
  command: ShellSourceCommand,
  options?: {
    agentId?: string;
    conversationId?: string;
    attributionConversationIds?: string[];
    backend?: ConversationTagBackend;
  },
): GitHubPullRequestOutputTracker | undefined {
  if (!isGitHubPullRequestCreateCommand(command)) {
    return undefined;
  }

  const runtimeContext = getRuntimeContext();
  const conversationId =
    options?.conversationId ?? runtimeContext?.conversationId;
  const agentId = options?.agentId ?? runtimeContext?.agentId;
  const environmentAttribution = process.env[GITHUB_PR_CONVERSATIONS_ENV];
  const currentAttributionConversationIds =
    options?.attributionConversationIds ??
    runtimeContext?.githubPullRequestConversationIds ??
    (environmentAttribution !== undefined
      ? environmentAttribution.split(",")
      : undefined);
  const attributionConversationIds = currentAttributionConversationIds ?? [];
  const targetConversationIds = [conversationId, ...attributionConversationIds]
    .filter(
      (id): id is string =>
        typeof id === "string" && id.length > 0 && id !== "default",
    )
    .filter((id, index, ids) => ids.indexOf(id) === index);
  if (
    targetConversationIds.length === 0 &&
    !(agentId && conversationId === "default")
  ) {
    return undefined;
  }

  const outputByStream: Record<OutputStream, string> = {
    stdout: "",
    stderr: "",
  };
  let finishPromise: Promise<void> | undefined;

  return {
    append(text, stream) {
      if (finishPromise) {
        return;
      }
      appendOutputTail(outputByStream, text, stream);
    },
    finish(signal) {
      if (finishPromise) {
        return finishPromise;
      }
      const tags = new Set<string>();
      for (const line of `${outputByStream.stdout}\n${outputByStream.stderr}`.split(
        /\r\n|\n|\r/,
      )) {
        const tag = tagFromOutputLine(line);
        if (tag) {
          tags.add(tag);
        }
      }
      if (tags.size === 0) {
        finishPromise = Promise.resolve();
        return finishPromise;
      }
      try {
        const backend = options?.backend ?? getBackend();
        const targeted = new Set<string>();
        const writes: Promise<void>[] = [];
        const append = (id: string) => {
          if (targeted.has(id)) return;
          targeted.add(id);
          const write = appendConversationTags(backend, id, [...tags], signal);
          // Discovery can outlive a rejected write; attach a handler immediately.
          void write.catch(() => {});
          writes.push(write);
        };
        targetConversationIds.forEach(append);
        const discover = async () => {
          if (currentAttributionConversationIds !== undefined) return;
          for await (const id of getPullRequestParentConversationIds(
            backend,
            { agentId, conversationId },
            signal,
          ))
            append(id);
        };
        finishPromise = waitForTagUpdate(discover(), signal)
          .then(() => Promise.all(writes))
          .then(() => undefined);
      } catch (error) {
        debugLog(
          "github-pr-tracking",
          `Failed to tag conversations ${targetConversationIds.join(", ")}`,
          error,
        );
        finishPromise = Promise.resolve();
      }
      return finishPromise;
    },
  };
}
