import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import type { ArtifactCallCommand } from "@/types/protocol_v2";

interface ArtifactServerLog {
  level: "log" | "info" | "warn" | "error" | "debug";
  message: string;
  timestamp: string;
}

interface ArtifactCallResult {
  result: unknown;
  logs: ArtifactServerLog[];
  updatedPaths: string[];
  pendingUpdatedPaths: string[];
  timings: ArtifactCallTimings;
}

interface ArtifactDataWrite {
  absolutePath: string;
  content: Buffer;
  pathspec: string;
}

export class ArtifactCallServerError extends Error {
  logs: ArtifactServerLog[];

  constructor(input: { message: string; logs: ArtifactServerLog[] }) {
    super(input.message);
    this.name = "ArtifactCallServerError";
    this.logs = input.logs;
  }
}

interface ArtifactDataApi {
  path: string;
  read: () => unknown;
  write: (value: unknown) => void;
}

interface ArtifactServerContext {
  appName: string;
  appRoot: string;
  serverRoot: string;
  data: ArtifactDataApi;
}

interface CreateDataApiInput {
  dataPath: string;
  memoryRoot: string;
  onWrite: (write: ArtifactDataWrite) => void;
}

interface CommitArtifactDataWritesInput {
  agentId: string;
  appName: string;
  memoryRoot: string;
  writes: ArtifactDataWrite[];
}

interface ArtifactCallTimings {
  total_ms: number;
  load_server_ms: number;
  run_function_ms: number;
  commit_ms: number;
  commit_deferred: boolean;
}

type ArtifactDataCommitMode = "await" | "defer";

interface DeferredArtifactDataCommitResult {
  updatedPaths: string[];
  error?: unknown;
  commitMs: number;
}

interface ServerModuleUrlCacheEntry {
  mtimeMs: number;
  size: number;
  href: string;
}

const ARTIFACT_SERVER_CALL_TIMEOUT_MS = 8_000;
const serverModuleUrlCache = new Map<string, ServerModuleUrlCacheEntry>();

const VALID_APP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALID_FUNCTION_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FORBIDDEN_FUNCTION_NAMES = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

function validateAppName(appName: string): void {
  if (
    appName === "." ||
    appName === ".." ||
    appName.includes("/") ||
    appName.includes("\\") ||
    !VALID_APP_NAME_PATTERN.test(appName)
  ) {
    throw new Error("artifact_call: app_name must be a safe external app name");
  }
}

function validateFunctionName(functionName: string): void {
  if (
    !VALID_FUNCTION_NAME_PATTERN.test(functionName) ||
    FORBIDDEN_FUNCTION_NAMES.has(functionName)
  ) {
    throw new Error("artifact_call: function_name is not callable");
  }
}

function ensureInsideRoot(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (
    rel.startsWith("..") ||
    rel === "" ||
    isAbsolute(rel) ||
    rel.split(sep).includes("..")
  ) {
    throw new Error("artifact_call: resolved path escapes memory root");
  }
}

function createDataApi(input: CreateDataApiInput): ArtifactDataApi {
  const { dataPath, memoryRoot, onWrite } = input;
  ensureInsideRoot(memoryRoot, dataPath);
  return {
    path: dataPath,
    read: () => {
      if (!existsSync(dataPath)) {
        return null;
      }
      const content = readFileSync(dataPath, "utf8");
      if (content.trim().length === 0) {
        return null;
      }
      return content;
    },
    write: (value) => {
      mkdirSync(dirname(dataPath), { recursive: true });
      const content =
        typeof value === "string" ? value : JSON.stringify(value, null, 2);
      const buffer = Buffer.from(`${content}\n`, "utf8");
      writeFileSync(dataPath, buffer);
      const rel = relative(memoryRoot, dataPath);
      onWrite({
        absolutePath: dataPath,
        content: buffer,
        pathspec: rel.split(sep).join("/"),
      });
    },
  };
}

async function getArtifactCommitAuthor(agentId: string): Promise<{
  agentId: string;
  authorName: string;
  authorEmail: string;
}> {
  let agentName = agentId;
  try {
    const { getBackend } = await import("@/backend");
    const backend = getBackend();
    const agent = await backend.retrieveAgent(agentId);
    if (agent.name && agent.name.trim().length > 0) {
      agentName = agent.name.trim();
    }
  } catch {
    // Best-effort — fall back to agent id as the author name.
  }

  return {
    agentId,
    authorName: agentName,
    authorEmail: `${agentId}@letta.com`,
  };
}

async function getArtifactMemorySyncMode(): Promise<"local" | undefined> {
  const { getBackend } = await import("@/backend");
  const backend = getBackend();
  return backend.capabilities.localMemfs && !backend.capabilities.remoteMemfs
    ? "local"
    : undefined;
}

async function commitArtifactDataWrites(
  input: CommitArtifactDataWritesInput,
): Promise<string[]> {
  if (input.writes.length === 0) return [];

  const writesByPathspec = new Map<string, ArtifactDataWrite>();
  for (const write of input.writes) {
    writesByPathspec.set(write.pathspec, write);
  }

  const pathspecs = [...writesByPathspec.keys()];
  const { commitAndSyncMemoryWrite } = await import("@/agent/memory-git");
  const author = await getArtifactCommitAuthor(input.agentId);
  const memorySyncMode = await getArtifactMemorySyncMode();
  const commitResult = await commitAndSyncMemoryWrite({
    memoryDir: input.memoryRoot,
    pathspecs,
    reason: `Update artifact data for ${input.appName}`,
    author,
    ...(memorySyncMode ? { syncMode: memorySyncMode } : {}),
    replay: async () => {
      for (const write of writesByPathspec.values()) {
        await mkdir(dirname(write.absolutePath), { recursive: true });
        await writeFile(write.absolutePath, write.content);
      }
      return pathspecs;
    },
  });

  return commitResult.committed ? pathspecs : [];
}

function nowMs(): number {
  return performance.now();
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function stripMemoryMarkdownFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  return content.slice(end + "\n---\n".length);
}

function unwrapFencedJavaScript(content: string): string {
  const trimmed = content.trim();
  const exactMatch = trimmed.match(
    /^```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)\n```$/i,
  );
  if (exactMatch?.[1] !== undefined) {
    return exactMatch[1];
  }

  const embeddedMatch = trimmed.match(
    /```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)\n```/i,
  );
  if (embeddedMatch?.[1] !== undefined) {
    return embeddedMatch[1];
  }

  return content;
}

function unwrapMarkdownJavaScript(content: string): string {
  return unwrapFencedJavaScript(stripMemoryMarkdownFrontmatter(content));
}

function normalizeServerSource(source: string): string {
  if (source.includes("module.exports")) {
    return source.replace(/module\.exports\s*=\s*/, "export default ");
  }
  if (source.includes("exports.default")) {
    return source.replace(/exports\.default\s*=\s*/, "export default ");
  }
  return source;
}

async function getServerModuleUrl(serverPath: string): Promise<string> {
  const stats = await stat(serverPath);
  const cached = serverModuleUrlCache.get(serverPath);
  if (cached?.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.href;
  }

  if (!serverPath.endsWith(".md")) {
    const serverUrl = pathToFileURL(serverPath);
    serverUrl.searchParams.set("mtime", String(stats.mtimeMs));
    serverModuleUrlCache.set(serverPath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      href: serverUrl.href,
    });
    return serverUrl.href;
  }

  const content = await readFile(serverPath, "utf8");
  const source = normalizeServerSource(unwrapMarkdownJavaScript(content));
  const digest = createHash("sha256")
    .update(serverPath)
    .update("\0")
    .update(source)
    .digest("hex")
    .slice(0, 24);
  const cacheDir = join(tmpdir(), "letta-artifact-server-modules");
  await mkdir(cacheDir, { recursive: true });
  const modulePath = join(cacheDir, `${digest}.mjs`);
  await writeFile(
    modulePath,
    `${source}\n//# sourceURL=${pathToFileURL(serverPath).href}\n`,
    "utf8",
  );
  const moduleUrl = pathToFileURL(modulePath);
  moduleUrl.searchParams.set("mtime", String(stats.mtimeMs));
  serverModuleUrlCache.set(serverPath, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    href: moduleUrl.href,
  });
  return moduleUrl.href;
}

function resolveServerPath(serverRoot: string): string | null {
  const serverPath = join(serverRoot, "server.js");
  if (existsSync(serverPath)) return serverPath;

  const markdownServerPath = join(serverRoot, "server.js.md");
  if (existsSync(markdownServerPath)) return markdownServerPath;

  return null;
}

function getExportedValue(moduleValue: object): unknown {
  const defaultExport = Reflect.get(moduleValue, "default");
  return defaultExport ?? moduleValue;
}

async function getServerApi(input: {
  serverPath: string;
  context: ArtifactServerContext;
}): Promise<unknown> {
  const moduleUrl = await getServerModuleUrl(input.serverPath);
  const moduleValue = await import(moduleUrl);
  const exportedValue = getExportedValue(moduleValue);
  if (typeof exportedValue === "function") {
    const api = await exportedValue(input.context);
    return api;
  }
  return exportedValue;
}

function toJsonSafeValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value));
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  return inspect(value, { depth: 6, breakLength: 120 });
}

async function captureArtifactServerLogs<T>(
  callback: () => Promise<T>,
): Promise<{ value: T; logs: ArtifactServerLog[] }> {
  const logs: ArtifactServerLog[] = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalDebug = console.debug;

  const createLogger = (
    level: ArtifactServerLog["level"],
    original: (...args: unknown[]) => void,
  ) => {
    return (...args: unknown[]): void => {
      logs.push({
        level,
        message: args.map(formatConsoleArg).join(" "),
        timestamp: new Date().toISOString(),
      });
      original(...args);
    };
  };

  console.log = createLogger("log", originalLog);
  console.info = createLogger("info", originalInfo);
  console.warn = createLogger("warn", originalWarn);
  console.error = createLogger("error", originalError);
  console.debug = createLogger("debug", originalDebug);

  try {
    const value = await callback();
    return { value, logs };
  } catch (err) {
    const message = err instanceof Error ? err.message : formatConsoleArg(err);
    logs.push({
      level: "error",
      message: err instanceof Error ? (err.stack ?? err.message) : message,
      timestamp: new Date().toISOString(),
    });
    throw new ArtifactCallServerError({ message, logs });
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
    console.debug = originalDebug;
  }
}

function withArtifactServerTimeout<T>(input: {
  callback: () => Promise<T>;
  label: string;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(
        new Error(
          `artifact_call: timed out after ${ARTIFACT_SERVER_CALL_TIMEOUT_MS}ms while ${input.label}`,
        ),
      );
    }, ARTIFACT_SERVER_CALL_TIMEOUT_MS);

    input
      .callback()
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

export async function callArtifactServerFunction(input: {
  command: ArtifactCallCommand;
  agentId: string;
  memoryRoot: string;
  commitMode?: ArtifactDataCommitMode;
  onDeferredCommitComplete?: (result: DeferredArtifactDataCommitResult) => void;
}): Promise<ArtifactCallResult> {
  const totalStartedAt = nowMs();
  let loadServerMs = 0;
  let runFunctionMs = 0;
  let commitMs = 0;
  const commitMode = input.commitMode ?? "await";
  validateAppName(input.command.app_name);
  validateFunctionName(input.command.function_name);

  const appRoot = normalize(
    join(input.memoryRoot, "external", "artifacts", input.command.app_name),
  );
  ensureInsideRoot(input.memoryRoot, appRoot);

  const serverRoot = join(appRoot, "server");
  const serverPath = resolveServerPath(serverRoot);
  if (!serverPath) {
    throw new Error(
      `artifact_call: missing server/server.js for artifact ${input.command.app_name}`,
    );
  }

  const dataWrites: ArtifactDataWrite[] = [];

  const context: ArtifactServerContext = {
    appName: input.command.app_name,
    appRoot,
    serverRoot,
    data: createDataApi({
      dataPath: join(serverRoot, "data.json"),
      memoryRoot: input.memoryRoot,
      onWrite: (write) => dataWrites.push(write),
    }),
  };

  let updatedPaths: string[] = [];

  const { value, logs } = await captureArtifactServerLogs(async () => {
    const loadStartedAt = nowMs();
    const api = await withArtifactServerTimeout({
      label: `loading server.js for ${input.command.app_name}`,
      callback: async () => await getServerApi({ serverPath, context }),
    });
    loadServerMs = elapsedMs(loadStartedAt);
    if (!api || typeof api !== "object") {
      throw new Error(
        "artifact_call: server.js must export or return an object",
      );
    }

    const fn = Reflect.get(api, input.command.function_name);
    if (typeof fn !== "function") {
      throw new Error(
        `artifact_call: function ${input.command.function_name} is not exported`,
      );
    }

    const runStartedAt = nowMs();
    const result = await withArtifactServerTimeout({
      label: `running ${input.command.function_name}`,
      callback: async () => await fn(input.command.args),
    });
    runFunctionMs = elapsedMs(runStartedAt);
    const safeResult = toJsonSafeValue(result);
    return safeResult;
  });

  const commitInput = {
    agentId: input.agentId,
    appName: input.command.app_name,
    memoryRoot: input.memoryRoot,
    writes: dataWrites,
  };
  const pendingUpdatedPaths = [
    ...new Set(dataWrites.map((write) => write.pathspec)),
  ];

  if (commitMode === "defer" && dataWrites.length > 0) {
    void (async () => {
      const commitStartedAt = nowMs();
      try {
        const deferredUpdatedPaths =
          await commitArtifactDataWrites(commitInput);
        input.onDeferredCommitComplete?.({
          updatedPaths: deferredUpdatedPaths,
          commitMs: elapsedMs(commitStartedAt),
        });
      } catch (err) {
        input.onDeferredCommitComplete?.({
          updatedPaths: [],
          error: err,
          commitMs: elapsedMs(commitStartedAt),
        });
      }
    })();
  } else {
    const commitStartedAt = nowMs();
    updatedPaths = await commitArtifactDataWrites({
      agentId: input.agentId,
      appName: input.command.app_name,
      memoryRoot: input.memoryRoot,
      writes: dataWrites,
    });
    commitMs = elapsedMs(commitStartedAt);
  }

  return {
    result: value,
    logs,
    updatedPaths,
    pendingUpdatedPaths,
    timings: {
      total_ms: elapsedMs(totalStartedAt),
      load_server_ms: loadServerMs,
      run_function_ms: runFunctionMs,
      commit_ms: commitMs,
      commit_deferred: commitMode === "defer" && dataWrites.length > 0,
    },
  };
}
