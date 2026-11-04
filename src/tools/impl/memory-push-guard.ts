import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";

/**
 * Keep the memory repository's contents from leaving it through shell tools.
 *
 * In managed cloud runtimes, shell commands are screened before they run:
 * - `git push` from the memory repository is allowed only to the memory
 *   remote (a `/v1/git/` endpoint or the configured memory-repository mirror).
 * - `git push` from any other repository is refused when the commits being
 *   pushed contain a file whose bytes match a file in the memory directory.
 * - `cp`/`rsync`/`scp` of the memory directory (or files in it) into another
 *   Git worktree or to a remote host is refused.
 *
 * This is a guardrail against well-meant copies, not a security boundary:
 * edited copies, archives, scripts that run git themselves, and uploads that
 * do not go through git are not detected.
 */

export const MEMORY_PUSH_BLOCKED_MESSAGE =
  "Blocked: this would push files from your memory directory to a remote other than the memory repository. Memory files stay in the memory repository; remove them from the commits you are pushing and try again.";

export const MEMORY_COPY_BLOCKED_MESSAGE =
  "Blocked: this would copy your memory directory into another Git repository or to a remote host. Memory files stay in the memory repository.";

/** Files smaller than this are too generic to treat as memory content. */
const MIN_MEMORY_FILE_BYTES = 64;
const GIT_TIMEOUT_MS = 10_000;
const MEMORY_REMOTE_PATH =
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+(?:\/[^\s]*)?\/v1\/git\//i;
const COPY_COMMANDS = new Set(["cp", "rsync", "scp"]);
const PREFIX_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "!",
  "{",
  "time",
  "command",
  "exec",
  "env",
  "sudo",
  "nohup",
]);

export interface MemoryPushGuardOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Returns a tool error message when the command would move memory out. */
export function findMemoryExfiltration(
  command: string,
  options: MemoryPushGuardOptions,
): string | null {
  const { env } = options;
  const memoryDir = (env.MEMORY_DIR || env.LETTA_MEMORY_DIR || "").trim();
  if (!isManagedCloudRuntime(env) || !memoryDir) return null;
  if (!/\b(push|cp|rsync|scp)\b/.test(command)) return null;
  const context = { env, memoryDir: resolve(memoryDir), depth: 0 };
  return scanCommand(command, options.cwd, context);
}

interface ScanContext {
  env: NodeJS.ProcessEnv;
  memoryDir: string;
  depth: number;
}

function scanCommand(
  command: string,
  startCwd: string,
  context: ScanContext,
): string | null {
  let cwd = startCwd;
  for (const segment of splitSegments(command)) {
    const words = tokenize(expandVariables(segment, context.env));
    while (words.length > 0) {
      const first = words[0] ?? "";
      if (!PREFIX_WORDS.has(first) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(first))
        break;
      words.shift();
    }
    const name = basename(words[0] ?? "");
    const args = words.slice(1);
    if (name === "cd") {
      cwd = resolvePath(cwd, args[0] ?? context.env.HOME ?? cwd);
    } else if (name === "git") {
      const blocked = checkGit(args, cwd, context);
      if (blocked) return blocked;
    } else if (COPY_COMMANDS.has(name)) {
      if (copiesMemoryOut(args, cwd, context)) {
        return MEMORY_COPY_BLOCKED_MESSAGE;
      }
    } else if (
      (name === "bash" || name === "sh" || name === "zsh") &&
      context.depth < 2
    ) {
      const index = args.findIndex((arg) => /^-[a-z]*c$/.test(arg));
      const inner = index >= 0 ? args[index + 1] : undefined;
      if (inner) {
        const nested = { ...context, depth: context.depth + 1 };
        const blocked = scanCommand(inner, cwd, nested);
        if (blocked) return blocked;
      }
    }
  }
  return null;
}

function checkGit(
  args: string[],
  startCwd: string,
  context: ScanContext,
): string | null {
  let cwd = startCwd;
  let index = 0;
  while (index < args.length && (args[index] ?? "").startsWith("-")) {
    const option = args[index] ?? "";
    if (option === "-C") {
      cwd = resolvePath(cwd, args[index + 1] ?? "");
      index += 2;
    } else if (["-c", "--git-dir", "--work-tree"].includes(option)) {
      index += 2;
    } else {
      index += 1;
    }
  }
  if (args[index] !== "push") return null;
  const pushArgs = args.slice(index + 1);
  const repoCommonDir = gitCommonDir(cwd);
  if (!repoCommonDir) return null;
  if (repoCommonDir === gitCommonDir(context.memoryDir)) {
    return pushesToMemoryRemote(pushArgs, cwd)
      ? null
      : MEMORY_PUSH_BLOCKED_MESSAGE;
  }
  return pushContainsMemoryFiles(pushArgs, cwd, context.memoryDir)
    ? MEMORY_PUSH_BLOCKED_MESSAGE
    : null;
}

interface ParsedPush {
  repository?: string;
  refspecs: string[];
  allBranches: boolean;
  tags: boolean;
}

function parsePushArgs(args: string[]): ParsedPush {
  const parsed: ParsedPush = { refspecs: [], allBranches: false, tags: false };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("--repo=")) {
      parsed.repository = arg.slice("--repo=".length);
    } else if (["--all", "--mirror", "--branches"].includes(arg)) {
      parsed.allBranches = true;
    } else if (arg === "--tags") {
      parsed.tags = true;
    } else if (
      ["-o", "--push-option", "--receive-pack", "--exec"].includes(arg)
    ) {
      index += 1;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  if (!parsed.repository) parsed.repository = positional.shift();
  parsed.refspecs = positional;
  return parsed;
}

function pushesToMemoryRemote(args: string[], cwd: string): boolean {
  const { repository } = parsePushArgs(args);
  const remote = repository ?? defaultPushRemote(cwd);
  const remotes = (git(cwd, ["remote"]) ?? "").split("\n").filter(Boolean);
  const urls = remotes.includes(remote)
    ? (git(cwd, ["remote", "get-url", "--push", "--all", remote]) ?? "")
        .split("\n")
        .filter(Boolean)
    : [remote];
  const mirror = git(cwd, ["config", "--get", "letta.memoryRepository.url"]);
  return (
    urls.length > 0 &&
    urls.every((url) => MEMORY_REMOTE_PATH.test(url) || url === mirror)
  );
}

function defaultPushRemote(cwd: string): string {
  const branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return (
    (branch && git(cwd, ["config", "--get", `branch.${branch}.pushRemote`])) ||
    git(cwd, ["config", "--get", "remote.pushDefault"]) ||
    (branch && git(cwd, ["config", "--get", `branch.${branch}.remote`])) ||
    "origin"
  );
}

function pushContainsMemoryFiles(
  args: string[],
  cwd: string,
  memoryDir: string,
): boolean {
  const memoryBlobs = collectMemoryBlobs(memoryDir);
  if (memoryBlobs.size === 0) return false;
  const parsed = parsePushArgs(args);
  const tips = parsed.refspecs
    .map((refspec) => refspec.replace(/^\+/, "").split(":")[0] ?? "")
    .filter(Boolean);
  if (parsed.allBranches) tips.push("--branches");
  if (parsed.tags) tips.push("--tags");
  if (tips.length === 0) tips.push("HEAD");
  const objects = git(cwd, [
    "rev-list",
    "--objects",
    ...tips,
    "--not",
    "--remotes",
  ]);
  if (!objects) return false;
  return objects
    .split("\n")
    .some((line) => memoryBlobs.has(line.split(" ")[0] ?? ""));
}

/** Blob IDs for memory files, both committed and as currently on disk. */
function collectMemoryBlobs(memoryDir: string): Set<string> {
  const blobs = new Set<string>();
  const tree = git(memoryDir, ["ls-tree", "-r", "-l", "HEAD"]) ?? "";
  for (const line of tree.split("\n")) {
    const match = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(line);
    if (match?.[1] && isMemoryContentFile(match[3] ?? "", Number(match[2]))) {
      blobs.add(match[1]);
    }
  }
  const paths = (
    git(memoryDir, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
    ]) ?? ""
  )
    .split("\n")
    .filter((path) =>
      isMemoryContentFile(path, fileSize(resolve(memoryDir, path))),
    );
  if (paths.length > 0) {
    const hashed = git(
      memoryDir,
      ["hash-object", "--stdin-paths"],
      paths.join("\n"),
    );
    for (const id of (hashed ?? "").split("\n")) if (id) blobs.add(id);
  }
  return blobs;
}

/** Skills are often shared on purpose, and tiny files are too generic. */
function isMemoryContentFile(path: string, size: number): boolean {
  return (
    Boolean(path) &&
    !path.startsWith("skills/") &&
    size >= MIN_MEMORY_FILE_BYTES
  );
}

function copiesMemoryOut(
  args: string[],
  cwd: string,
  context: ScanContext,
): boolean {
  let target: string | undefined;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-t" || arg === "--target-directory") {
      target = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--target-directory=")) {
      target = arg.slice("--target-directory=".length);
    } else if (!arg.startsWith("-")) {
      operands.push(arg);
    }
  }
  if (!target) target = operands.pop();
  if (!target || operands.length === 0) return false;
  const memoryDir = canonical(context.memoryDir);
  const touchesMemory = operands.some((operand) => {
    if (isRemoteSpec(operand)) return false;
    const source = canonical(resolvePath(cwd, operand.replace(/[*?[].*$/, "")));
    return isWithin(source, memoryDir) || isWithin(memoryDir, source);
  });
  if (!touchesMemory) return false;
  if (isRemoteSpec(target)) return true;
  const targetCommonDir = gitCommonDir(
    nearestExistingDir(resolvePath(cwd, target)),
  );
  return (
    targetCommonDir !== null &&
    targetCommonDir !== gitCommonDir(context.memoryDir)
  );
}

function isRemoteSpec(value: string): boolean {
  return /^[^/]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value);
}

function nearestExistingDir(path: string): string {
  let current = path;
  while (fileSize(current) < 0 || !statSync(current).isDirectory()) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function gitCommonDir(cwd: string): string | null {
  const dir = git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return dir ? canonical(dir) : null;
}

function git(cwd: string, args: string[], input?: string): string | null {
  try {
    const result = spawnSync("git", args, {
      cwd,
      input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolvePath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

function expandVariables(segment: string, env: NodeJS.ProcessEnv): string {
  return segment
    .replace(
      /(^|[\s=])~(?=\/|\s|$)/g,
      (_match, lead: string) => `${lead}${env.HOME ?? "~"}`,
    )
    .replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match, braced?: string, bare?: string) =>
        env[braced ?? bare ?? ""] ?? match,
    );
}

/** Split on unquoted `;`, `&`, `|`, parentheses, backticks and newlines. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"') {
        current += char + (command[index + 1] ?? "");
        index += 1;
        continue;
      }
      current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === "\\") {
      current += char + (command[index + 1] ?? "");
      index += 1;
    } else if (";&|()`\n".includes(char)) {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** Shell words with quotes removed and redirections dropped. */
function tokenize(segment: string): string[] {
  const words =
    segment.match(/(?:[^\s"'\\]+|\\.|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
  const result: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const redirect = /^\d*(?:>>?|<)(.*)$/.exec(word);
    if (redirect) {
      if (!redirect[1]) index += 1;
      continue;
    }
    result.push(
      word.replace(
        /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g,
        (_m, single, double, escaped) =>
          single ??
          (double !== undefined ? double.replace(/\\(.)/g, "$1") : escaped),
      ),
    );
  }
  return result;
}
