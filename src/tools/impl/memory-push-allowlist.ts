import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Optional push-destination allowlist for the memory repository.
 *
 * Set `LETTA_MEMORY_PUSH_ALLOWED_REMOTES` to a comma-separated list of remote
 * URLs. Entries ending in `.git` match that repository exactly; other entries
 * match as path prefixes. When it is set, shell commands run through the Bash
 * and exec_command tools are checked before they start:
 * - `git push` from the memory repository must target its own `origin` or a
 *   URL matching an allowed entry.
 * - `git push` from another repository must not carry a file whose bytes match
 *   a file in the memory directory, unless it targets an allowed URL.
 * - Destinations are resolved by git with the command's own global options
 *   (`-c`, `--config-env`, `--git-dir`, ...) and environment assignments, so
 *   config overrides are taken into account. A push whose options cannot be
 *   reproduced that way is refused. Aliases are expanded; `!` shell aliases
 *   are refused.
 * - `git config` / `git remote` writes that could redirect the memory
 *   repository's pushes are refused unless the new URL is allowed.
 * - `cp`/`rsync`/`scp` of the memory directory into another Git worktree or to
 *   a remote host is refused, since that copy would be pushed from there.
 *
 * When the variable is unset, or on Windows, nothing is checked. Pushes made by the memory
 * repository's own hooks (including the `/memory-repository` mirror) do not
 * go through these tools and are unaffected.
 */

export const MEMORY_PUSH_ALLOWLIST_ENV = "LETTA_MEMORY_PUSH_ALLOWED_REMOTES";

export const MEMORY_PUSH_BLOCKED_MESSAGE = `Blocked: memory repository contents can only be pushed to the memory remote or to a remote listed in ${MEMORY_PUSH_ALLOWLIST_ENV}. Remove memory files from the commits you are pushing, or push to an allowed remote.`;

export const MEMORY_PUSH_UNVERIFIED_MESSAGE = `Blocked: the destination of this git push cannot be checked while ${MEMORY_PUSH_ALLOWLIST_ENV} is set. Run git push as a single command with an allowed remote URL, without options or aliases that change it.`;

export const MEMORY_CONFIG_BLOCKED_MESSAGE = `Blocked: changing remotes, URL rewrites, aliases, hooks or includes of the memory repository or of global git config is disabled while ${MEMORY_PUSH_ALLOWLIST_ENV} is set, unless the new URL is allowed.`;

export const MEMORY_COPY_BLOCKED_MESSAGE = `Blocked: copying the memory directory into another Git repository or to a remote host is disabled while ${MEMORY_PUSH_ALLOWLIST_ENV} is set. Memory files stay in the memory repository.`;

/** Files smaller than this are too generic to treat as memory content. */
const MIN_MEMORY_FILE_BYTES = 64;
const GIT_TIMEOUT_MS = 10_000;
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

export interface MemoryPushAllowlistOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * The shell may have changed directory or environment since `cwd`/`env`
   * were captured (lines typed into an interactive session). Pushes are then
   * allowed only to an explicitly given, allowed URL.
   */
  shellStateUnknown?: boolean;
}

/** Returns a tool error when the command breaks the configured allowlist. */
export async function checkMemoryPushAllowlist(
  command: string,
  options: MemoryPushAllowlistOptions,
): Promise<string | null> {
  const { env } = options;
  const memoryDir = (env.MEMORY_DIR || env.LETTA_MEMORY_DIR || "").trim();
  const allowed = parseAllowedRemotes(env[MEMORY_PUSH_ALLOWLIST_ENV]);
  // Command parsing assumes POSIX shell syntax and paths.
  if (process.platform === "win32") return null;
  if (allowed.length === 0 || !memoryDir) return null;
  if (
    options.shellStateUnknown &&
    /\bGIT_(CONFIG\w*|DIR|COMMON_DIR|WORK_TREE|NAMESPACE|EXEC_PATH)=/.test(
      command,
    )
  ) {
    // Later typed lines would run with this environment, which we cannot see.
    return MEMORY_PUSH_UNVERIFIED_MESSAGE;
  }
  if (!/\b(git|push|cp|rsync|scp)\b/.test(command)) return null;
  const context = {
    env,
    memoryDir: resolve(memoryDir),
    allowed,
    depth: 0,
    shellStateUnknown: options.shellStateUnknown ?? false,
  };
  return scanCommand(command, options.cwd, context);
}

function parseAllowedRemotes(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => normalizeRemoteUrl(entry))
    .filter((entry): entry is string => Boolean(entry));
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalizes a remote URL to `scheme://host[:port]/path` without credentials,
 * query or trailing slashes. Returns null for URLs that cannot be compared
 * safely: dot segments (plain or percent-encoded), encoded or back-slashes,
 * queries and fragments can all make the request go to a different path than
 * the string suggests.
 */
function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed || /[?#\\]|%2f|%5c/i.test(trimmed)) return null;
  if (!URL_SCHEME.test(trimmed)) {
    // scp-style (`user@host:path`) or local path.
    if (hasDotSegment(trimmed.split(/[/:]/))) return null;
    return trimmed.replace(/\/+$/, "");
  }
  const rawPath = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  if (hasDotSegment(rawPath.split("/"))) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(
    /\/+$/,
    "",
  );
}

function hasDotSegment(segments: string[]): boolean {
  return segments.some((segment) => {
    const decoded = segment.replace(/%2e/gi, ".");
    return decoded === "." || decoded === "..";
  });
}

interface ScanContext {
  env: NodeJS.ProcessEnv;
  memoryDir: string;
  allowed: string[];
  depth: number;
  shellStateUnknown: boolean;
}

/**
 * Where and how probe commands run so they see the same repository and
 * configuration as the command being checked: the working directory, the
 * command's global git options, and its environment.
 */
interface GitTarget {
  cwd: string;
  options: string[];
  env: NodeJS.ProcessEnv;
}

/** Global git options that take a separate value argument. */
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--config-env",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);
/** Frequent built-in subcommands, which skip the alias lookup. */
const GIT_COMMON_BUILTINS = new Set([
  "add",
  "branch",
  "checkout",
  "cherry-pick",
  "clone",
  "commit",
  "config",
  "diff",
  "fetch",
  "init",
  "log",
  "ls-files",
  "merge",
  "pull",
  "rebase",
  "remote",
  "reset",
  "restore",
  "rev-parse",
  "show",
  "stash",
  "status",
  "switch",
  "tag",
  "worktree",
]);
/** Global git options without a value that probes can safely repeat. */
const GIT_FLAG_OPTIONS = new Set([
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--bare",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-advice",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
]);

async function scanCommand(
  command: string,
  startCwd: string,
  context: ScanContext,
): Promise<string | null> {
  let cwd = startCwd;
  let shellEnv = context.env;
  for (const segment of splitSegments(command)) {
    const words = tokenize(expandVariables(segment, shellEnv));
    const assignments: Record<string, string> = {};
    while (words.length > 0) {
      const first = words[0] ?? "";
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(first);
      if (assignment?.[1]) assignments[assignment[1]] = assignment[2] ?? "";
      else if (!PREFIX_WORDS.has(first) && first !== "export") break;
      words.shift();
    }
    if (words.length === 0) {
      // `export NAME=value` or a bare assignment lasts for later commands.
      shellEnv = { ...shellEnv, ...assignments };
      continue;
    }
    const env = { ...shellEnv, ...assignments };
    const name = basename(words[0] ?? "");
    const args = words.slice(1);
    if (name === "cd") {
      cwd = resolvePath(cwd, args[0] ?? env.HOME ?? cwd);
    } else if (name === "git") {
      const blocked = await checkGit(args, cwd, env, assignments, context);
      if (blocked) return blocked;
    } else if (COPY_COMMANDS.has(name)) {
      if (await copiesMemoryOut(args, cwd, context)) {
        return MEMORY_COPY_BLOCKED_MESSAGE;
      }
    } else if (name === "eval" && context.depth < 2) {
      const nested = { ...context, env, depth: context.depth + 1 };
      const blocked = await scanCommand(args.join(" "), cwd, nested);
      if (blocked) return blocked;
    } else if (
      (name === "source" || name === ".") &&
      /\b(git|push)\b/.test(command) &&
      !isRegularFile(resolvePath(cwd, args[0] ?? ""))
    ) {
      // Commands sourced from a string or a pipe cannot be read ahead.
      return MEMORY_PUSH_UNVERIFIED_MESSAGE;
    } else if (
      (name === "bash" || name === "sh" || name === "zsh") &&
      context.depth < 2
    ) {
      const index = args.findIndex((arg) => /^-[a-z]*c$/.test(arg));
      const inner = index >= 0 ? args[index + 1] : undefined;
      if (inner) {
        const nested = { ...context, env, depth: context.depth + 1 };
        const blocked = await scanCommand(inner, cwd, nested);
        if (blocked) return blocked;
      }
    }
  }
  return null;
}

async function checkGit(
  args: string[],
  startCwd: string,
  env: NodeJS.ProcessEnv,
  assignments: Record<string, string>,
  context: ScanContext,
  aliasDepth = 0,
): Promise<string | null> {
  let cwd = startCwd;
  const options: string[] = [];
  let reproducible = true;
  let index = 0;
  while (index < args.length && (args[index] ?? "").startsWith("-")) {
    const option = args[index] ?? "";
    if (option === "-C") {
      cwd = resolvePath(cwd, args[index + 1] ?? "");
      index += 2;
    } else if (GIT_OPTIONS_WITH_VALUE.has(option)) {
      options.push(option, args[index + 1] ?? "");
      index += 2;
    } else {
      const flag = option.split("=")[0] ?? "";
      if (option.includes("=") && GIT_OPTIONS_WITH_VALUE.has(flag)) {
        options.push(option);
      } else if (GIT_FLAG_OPTIONS.has(option)) {
        options.push(option);
      } else {
        reproducible = false;
      }
      index += 1;
    }
  }
  const subcommand = args[index] ?? "";
  if (subcommand === "config" || subcommand === "remote") {
    const target: GitTarget = { cwd, options, env };
    return (await changesPushConfig(
      subcommand,
      args.slice(index + 1),
      target,
      context,
    ))
      ? MEMORY_CONFIG_BLOCKED_MESSAGE
      : null;
  }
  if (subcommand !== "push") {
    // Built-in commands cannot be redefined by an alias; anything else might
    // be one, and a `!` alias runs a shell command we cannot see into.
    if (!subcommand || GIT_COMMON_BUILTINS.has(subcommand)) return null;
    const aliasArgs = ["config", "--get", `alias.${subcommand}`];
    const alias =
      (await probe({ cwd, options, env }, aliasArgs)) ??
      // The shell may have moved into the memory repository.
      (context.shellStateUnknown
        ? await probe({ cwd: context.memoryDir, options, env }, aliasArgs)
        : null);
    if (!alias) return null;
    if (alias.trimStart().startsWith("!") || aliasDepth >= 5) {
      return MEMORY_PUSH_UNVERIFIED_MESSAGE;
    }
    const expanded = [
      ...args.slice(0, index),
      ...tokenize(alias),
      ...args.slice(index + 1),
    ];
    return checkGit(
      expanded,
      startCwd,
      env,
      assignments,
      context,
      aliasDepth + 1,
    );
  }
  // A value the shell would still expand cannot be reproduced by the probe.
  const values = [...options, ...Object.values(assignments)];
  if (!reproducible || values.some((value) => /[$`]/.test(value))) {
    return MEMORY_PUSH_UNVERIFIED_MESSAGE;
  }
  const target: GitTarget = { cwd, options, env };
  const pushArgs = args.slice(index + 1);
  const origins = await memoryOrigins(context.memoryDir);
  if (context.shellStateUnknown) {
    // The repository and its config depend on where the shell is now.
    const { repository } = parsePushArgs(pushArgs);
    const urls = repository ? await pushUrls(pushArgs, target) : [];
    const verified =
      repository !== undefined &&
      isAllowedUrl(repository, origins, context.allowed) &&
      urls.length > 0 &&
      urls.every((url) => isAllowedUrl(url, origins, context.allowed));
    return verified ? null : MEMORY_PUSH_UNVERIFIED_MESSAGE;
  }
  const repoCommonDir = await gitCommonDir(target);
  if (!repoCommonDir) return null;
  const urls = await pushUrls(pushArgs, target);
  if (
    urls.length > 0 &&
    urls.every((url) => isAllowedUrl(url, origins, context.allowed))
  ) {
    return null;
  }
  if (repoCommonDir === (await gitCommonDir(context.memoryDir))) {
    return MEMORY_PUSH_BLOCKED_MESSAGE;
  }
  return (await pushContainsMemoryFiles(pushArgs, target, context.memoryDir))
    ? MEMORY_PUSH_BLOCKED_MESSAGE
    : null;
}

const CONFIG_OPTIONS_WITH_VALUE = new Set([
  "--blob",
  "--type",
  "--default",
  "--comment",
  "--value",
]);
const CONFIG_READ_OPTIONS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--get-color",
  "--get-colorbool",
  "-l",
  "--list",
  "--unset",
  "--unset-all",
  "--remove-section",
]);
const CONFIG_READ_SUBCOMMANDS = new Set([
  "get",
  "list",
  "unset",
  "remove-section",
]);

/**
 * Probes read config before the command runs, so a `git config` or
 * `git remote` write followed by a push in the same command would be checked
 * against stale config. Writes that can change where the memory repository
 * pushes (in its own config or in global config) are refused unless the new
 * URL is allowed.
 */
async function changesPushConfig(
  subcommand: "config" | "remote",
  args: string[],
  target: GitTarget,
  context: ScanContext,
): Promise<boolean> {
  let shared = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (subcommand === "remote") {
      if (arg === "-t" || arg === "-m") index += 1;
      else if (!arg.startsWith("-")) positional.push(arg);
    } else if (["--global", "--system", "--file", "-f"].includes(arg)) {
      shared = true;
      if (arg === "--file" || arg === "-f") index += 1;
    } else if (arg.startsWith("--file=")) {
      shared = true;
    } else if (CONFIG_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
    } else if (CONFIG_READ_OPTIONS.has(arg)) {
      return false;
    } else if (["-e", "--edit", "--rename-section"].includes(arg)) {
      positional.unshift("edit");
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  const memoryCommonDir = await gitCommonDir(context.memoryDir);
  if (
    !shared &&
    !context.shellStateUnknown &&
    (await gitCommonDir(target)) !== memoryCommonDir
  ) {
    return false;
  }
  const origins = await memoryOrigins(context.memoryDir);
  const allowed = (url: string | undefined) =>
    url !== undefined && isAllowedUrl(url, origins, context.allowed);
  if (subcommand === "remote") {
    const [action, , url] = positional;
    if (action === "add" || action === "set-url") return !allowed(url);
    return action === "rename";
  }
  if (CONFIG_READ_SUBCOMMANDS.has(positional[0] ?? "")) return false;
  if (positional[0] === "edit" || positional[0] === "rename-section") {
    return true;
  }
  if (positional[0] === "set") positional.shift();
  const [key = "", value] = positional;
  if (value === undefined) return false;
  const lower = key.toLowerCase();
  if (/^remote\..+\.(url|pushurl)$/.test(lower)) return !allowed(value);
  if (/^url\..+\.(push)?insteadof$/.test(lower)) {
    return !allowed(key.slice("url.".length, key.lastIndexOf(".")));
  }
  return /^(remote\.|url\.|alias\.|include|core\.hookspath$|branch\..+\.pushremote$)/.test(
    lower,
  );
}

/** Runs a git probe the way the checked command would run git. */
function probe(target: GitTarget, args: string[]): Promise<string | null> {
  return git(target.cwd, [...target.options, ...args], undefined, target.env);
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

/**
 * The URLs a push would send to, resolved the way git resolves them: a
 * configured remote's `pushurl` (with `insteadOf` applied) or its `url`
 * (with `pushInsteadOf`, else `insteadOf`, applied); anything else is used as
 * a URL with the same rewrites. Config is read through the probe, so
 * overrides from `-c`, `--config-env` and the environment count.
 */
async function pushUrls(args: string[], target: GitTarget): Promise<string[]> {
  const { repository } = parsePushArgs(args);
  const remote = repository ?? (await defaultPushRemote(target));
  const rewrites = await urlRewrites(target);
  const configured = async (key: string) =>
    (
      (await probe(target, [
        "config",
        "--get-all",
        `remote.${remote}.${key}`,
      ])) ?? ""
    )
      .split("\n")
      .filter(Boolean);
  const pushurls = await configured("pushurl");
  if (pushurls.length > 0) {
    return pushurls.map((url) => rewriteUrl(url, rewrites.fetch) ?? url);
  }
  const urls = await configured("url");
  return (urls.length > 0 ? urls : [remote]).map(
    (url) =>
      rewriteUrl(url, rewrites.push) ?? rewriteUrl(url, rewrites.fetch) ?? url,
  );
}

interface UrlRewrite {
  base: string;
  prefix: string;
}

/** `url.<base>.insteadOf` and `url.<base>.pushInsteadOf` from all config. */
async function urlRewrites(
  target: GitTarget,
): Promise<{ fetch: UrlRewrite[]; push: UrlRewrite[] }> {
  const output = await probe(target, [
    "config",
    "-z",
    "--get-regexp",
    "^url\\..*\\.(push)?insteadof$",
  ]);
  const rewrites = { fetch: [] as UrlRewrite[], push: [] as UrlRewrite[] };
  for (const entry of (output ?? "").split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const key = entry.slice(0, newline);
    const prefix = entry.slice(newline + 1);
    const dot = key.lastIndexOf(".");
    const base = key.slice("url.".length, dot);
    const kind = key.slice(dot + 1).toLowerCase();
    if (!prefix) continue;
    (kind === "pushinsteadof" ? rewrites.push : rewrites.fetch).push({
      base,
      prefix,
    });
  }
  return rewrites;
}

/** Git's rule: the longest matching prefix wins. */
function rewriteUrl(url: string, rewrites: UrlRewrite[]): string | null {
  let best: UrlRewrite | null = null;
  for (const rewrite of rewrites) {
    if (
      url.startsWith(rewrite.prefix) &&
      (!best || rewrite.prefix.length > best.prefix.length)
    ) {
      best = rewrite;
    }
  }
  return best ? best.base + url.slice(best.prefix.length) : null;
}

/** Push URLs of the memory repository's own `origin`, normalized. */
async function memoryOrigins(memoryDir: string): Promise<string[]> {
  const urls = await git(memoryDir, [
    "remote",
    "get-url",
    "--push",
    "--all",
    "origin",
  ]);
  return (urls ?? "")
    .split("\n")
    .map((url) => normalizeRemoteUrl(url))
    .filter((url): url is string => Boolean(url));
}

/**
 * The memory repository's own origin, or a configured entry. Entries ending
 * in `.git` name one repository and match exactly; other entries match as
 * path prefixes.
 */
function isAllowedUrl(
  url: string,
  origins: string[],
  allowed: string[],
): boolean {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return false;
  return (
    origins.includes(normalized) ||
    allowed.some((entry) => {
      if (normalized === entry) return true;
      if (entry.endsWith(".git")) return false;
      return (
        normalized.startsWith(`${entry}/`) ||
        (entry.endsWith(":") && normalized.startsWith(entry))
      );
    })
  );
}

async function defaultPushRemote(target: GitTarget): Promise<string> {
  const branch = await probe(target, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  return (
    (branch &&
      (await probe(target, [
        "config",
        "--get",
        `branch.${branch}.pushRemote`,
      ]))) ||
    (await probe(target, ["config", "--get", "remote.pushDefault"])) ||
    (branch &&
      (await probe(target, ["config", "--get", `branch.${branch}.remote`]))) ||
    "origin"
  );
}

async function pushContainsMemoryFiles(
  args: string[],
  target: GitTarget,
  memoryDir: string,
): Promise<boolean> {
  const memoryBlobs = await collectMemoryBlobs(memoryDir);
  if (memoryBlobs.size === 0) return false;
  const parsed = parsePushArgs(args);
  const tips = parsed.refspecs
    .map((refspec) => refspec.replace(/^\+/, "").split(":")[0] ?? "")
    .filter(Boolean);
  if (parsed.allBranches) tips.push("--branches");
  if (parsed.tags) tips.push("--tags");
  if (tips.length === 0) tips.push("HEAD");
  const objects = await probe(target, [
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
async function collectMemoryBlobs(memoryDir: string): Promise<Set<string>> {
  const blobs = new Set<string>();
  const tree = (await git(memoryDir, ["ls-tree", "-r", "-l", "HEAD"])) ?? "";
  for (const line of tree.split("\n")) {
    const match = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(line);
    if (match?.[1] && isMemoryContentFile(match[3] ?? "", Number(match[2]))) {
      blobs.add(match[1]);
    }
  }
  const paths = (
    (await git(memoryDir, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
    ])) ?? ""
  )
    .split("\n")
    .filter((path) =>
      isMemoryContentFile(path, fileSize(resolve(memoryDir, path))),
    );
  if (paths.length > 0) {
    const hashed = await git(
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

async function copiesMemoryOut(
  args: string[],
  cwd: string,
  context: ScanContext,
): Promise<boolean> {
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
  const targetCommonDir = await gitCommonDir(
    nearestExistingDir(resolvePath(cwd, target)),
  );
  return (
    targetCommonDir !== null &&
    targetCommonDir !== (await gitCommonDir(context.memoryDir))
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

async function gitCommonDir(where: string | GitTarget): Promise<string | null> {
  const target =
    typeof where === "string"
      ? { cwd: where, options: [], env: process.env }
      : where;
  const dir = await probe(target, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return dir ? canonical(dir) : null;
}

/** Runs git without blocking the event loop; null on any failure. */
function git(
  cwd: string,
  args: string[],
  input?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return new Promise((resolveOutput) => {
    try {
      const child = execFile(
        "git",
        args,
        {
          cwd,
          env,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          timeout: GIT_TIMEOUT_MS,
        },
        (error, stdout) => resolveOutput(error ? null : stdout.trim()),
      );
      child.stdin?.end(input ?? "");
    } catch {
      resolveOutput(null);
    }
  });
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
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
