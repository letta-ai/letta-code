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
  retrieveConversation(conversationId: string): Promise<unknown>;
  updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
  ): Promise<unknown>;
};

export interface GitHubPullRequestOutputTracker {
  append(text: string, stream: OutputStream): void;
  finish(): Promise<void>;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const GITHUB_PR_URL =
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d*)\/?$/i;
const MAX_TRACKED_OUTPUT_CHARS = 30_000;

const GH_GLOBAL_FLAGS_WITH_VALUES = new Set(["--hostname", "--repo", "-R"]);

const conversationTagUpdateTails = new Map<string, Promise<void>>();

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

  const segments = splitShellSegmentsAllowCommandSubstitution(command) ?? [
    command,
  ];
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
  return `github:pull-request:${owner.toLowerCase()}:${repo.toLowerCase()}:${number}`;
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
): Promise<void> {
  const conversation = await backend.retrieveConversation(conversationId);
  const currentTags =
    typeof conversation === "object" && conversation !== null
      ? Reflect.get(conversation, "tags")
      : undefined;
  const existingTags = Array.isArray(currentTags)
    ? currentTags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const missingTags = tags.filter((tag) => !existingTags.includes(tag));
  if (missingTags.length === 0) {
    return;
  }

  await backend.updateConversation(conversationId, {
    tags: [...new Set([...existingTags, ...missingTags])],
  } as ConversationUpdateBody);
}

function queueConversationTagUpdate(
  backend: ConversationTagBackend,
  conversationId: string,
  tags: readonly string[],
): Promise<void> {
  const previous = conversationTagUpdateTails.get(conversationId);
  const update = (previous ?? Promise.resolve())
    .then(() => appendConversationTags(backend, conversationId, tags))
    .catch((error: unknown) => {
      debugLog(
        "github-pr-tracking",
        `Failed to tag conversation ${conversationId}`,
        error,
      );
    });
  conversationTagUpdateTails.set(conversationId, update);
  void update.finally(() => {
    if (conversationTagUpdateTails.get(conversationId) === update) {
      conversationTagUpdateTails.delete(conversationId);
    }
  });
  return update;
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
