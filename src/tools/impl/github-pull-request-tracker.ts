import stripAnsi from "strip-ansi";
import { type ConversationUpdateBody, getBackend } from "@/backend";
import {
  splitShellSegmentsAllowCommandSubstitution,
  tokenizeShellWords,
} from "@/permissions/shell-analysis";
import { getRuntimeContext } from "@/runtime-context";
import { debugLog } from "@/utils/debug";

export type ShellSourceCommand = string | readonly string[];

type OutputStream = "stdout" | "stderr";

export type ConversationTagBackend = {
  retrieveConversation(
    conversationId: string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
};

export interface GitHubPullRequestOutputTracker {
  append(text: string, stream: OutputStream): void;
  finish(): Promise<void>;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const GITHUB_PR_URL =
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d*)\/?$/i;
const GITHUB_PR_TAG_PREFIX = "github:pull-request:";
const HEREDOC_AT_LINE_END =
  /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([^\s'"`<>|&;]+))\s*$/;
const MAX_TRACKED_OUTPUT_CHARS = 30_000;

const GH_GLOBAL_FLAGS_WITH_VALUES = new Set(["--hostname", "--repo", "-R"]);

const conversationTagUpdateTails = new Map<string, Promise<void>>();

function conversationTags(conversation: unknown): string[] {
  const tags =
    typeof conversation === "object" && conversation !== null
      ? Reflect.get(conversation, "tags")
      : undefined;
  return Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === "string")
    : [];
}

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
  const executableIndex = findExecutableIndex(tokens);
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
  const executableIndex = findExecutableIndex(tokens);
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
  const conversation = await backend.retrieveConversation(conversationId, {
    signal,
  });
  const existingTags = conversationTags(conversation);
  const missingTags = tags.filter((tag) => !existingTags.includes(tag));
  if (missingTags.length === 0) {
    return;
  }

  await backend.updateConversation(
    conversationId,
    {
      tags: [...new Set([...existingTags, ...missingTags])],
    } as ConversationUpdateBody,
    { signal },
  );
}

function queueConversationTagUpdate(
  backend: ConversationTagBackend,
  conversationId: string,
  tags: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const previous = conversationTagUpdateTails.get(conversationId);
  const update = (previous ?? Promise.resolve())
    .then(() => appendConversationTags(backend, conversationId, tags, signal))
    .catch((error: unknown) => {
      if (signal?.aborted) {
        signal.throwIfAborted();
      }
      debugLog(
        "github-pr-tracking",
        `Failed to tag conversation ${conversationId}`,
        error,
      );
    });
  const tail = update.catch(() => {});
  conversationTagUpdateTails.set(conversationId, tail);
  void tail
    .finally(() => {
      if (conversationTagUpdateTails.get(conversationId) === tail) {
        conversationTagUpdateTails.delete(conversationId);
      }
    })
    .catch(() => {});
  return update;
}

/** Copy PRs opened in an Agent conversation onto its launching conversation. */
export async function copyGitHubPullRequestTags(
  sourceConversationId: string | undefined,
  targetConversationId: string | undefined,
  backend?: ConversationTagBackend,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !sourceConversationId ||
    !targetConversationId ||
    sourceConversationId === "default" ||
    targetConversationId === "default" ||
    sourceConversationId === targetConversationId
  ) {
    return;
  }

  try {
    const activeBackend = backend ?? getBackend();
    const sourceConversation = await activeBackend.retrieveConversation(
      sourceConversationId,
      { signal },
    );
    const pullRequestTags = conversationTags(sourceConversation).filter((tag) =>
      tag.startsWith(GITHUB_PR_TAG_PREFIX),
    );
    if (pullRequestTags.length === 0) {
      return;
    }
    await queueConversationTagUpdate(
      activeBackend,
      targetConversationId,
      pullRequestTags,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) {
      signal.throwIfAborted();
    }
    debugLog(
      "github-pr-tracking",
      `Failed to copy PR tags from ${sourceConversationId} to ${targetConversationId}`,
      error,
    );
  }
}

export function createGitHubPullRequestOutputTracker(
  command: ShellSourceCommand,
  options?: {
    conversationId?: string;
    backend?: ConversationTagBackend;
  },
): GitHubPullRequestOutputTracker | undefined {
  if (!isGitHubPullRequestCreateCommand(command)) {
    return undefined;
  }

  const conversationId =
    options?.conversationId ?? getRuntimeContext()?.conversationId;
  if (!conversationId || conversationId === "default") {
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
    finish() {
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
        finishPromise = queueConversationTagUpdate(
          options?.backend ?? getBackend(),
          conversationId,
          [...tags],
        );
      } catch (error) {
        debugLog(
          "github-pr-tracking",
          `Failed to tag conversation ${conversationId}`,
          error,
        );
        finishPromise = Promise.resolve();
      }
      return finishPromise;
    },
  };
}
