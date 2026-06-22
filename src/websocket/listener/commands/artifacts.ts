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

const ARTIFACT_SERVER_CALL_TIMEOUT_MS = 8_000;

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

function createDataApi(dataPath: string): ArtifactDataApi {
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
      writeFileSync(dataPath, `${content}\n`, "utf8");
    },
  };
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
  if (!serverPath.endsWith(".md")) {
    const serverUrl = pathToFileURL(serverPath);
    serverUrl.searchParams.set("mtime", String(stats.mtimeMs));
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
  console.debug(`artifact_call: resolving module URL for ${input.serverPath}`);
  const moduleUrl = await getServerModuleUrl(input.serverPath);
  console.debug(`artifact_call: importing module for ${input.serverPath}`);
  const moduleValue = await import(moduleUrl);
  console.debug(`artifact_call: imported module for ${input.serverPath}`);
  const exportedValue = getExportedValue(moduleValue);
  if (typeof exportedValue === "function") {
    console.debug(
      `artifact_call: calling server factory for ${input.serverPath}`,
    );
    const api = await exportedValue(input.context);
    console.debug(
      `artifact_call: server factory returned for ${input.serverPath}`,
    );
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
  memoryRoot: string;
}): Promise<ArtifactCallResult> {
  validateAppName(input.command.app_name);
  validateFunctionName(input.command.function_name);

  const appRoot = normalize(
    join(input.memoryRoot, "external", input.command.app_name),
  );
  ensureInsideRoot(input.memoryRoot, appRoot);

  const serverRoot = join(appRoot, "server");
  const serverPath = resolveServerPath(serverRoot);
  if (!serverPath) {
    throw new Error(
      `artifact_call: missing server/server.js for ${input.command.app_name}`,
    );
  }

  const context: ArtifactServerContext = {
    appName: input.command.app_name,
    appRoot,
    serverRoot,
    data: createDataApi(join(serverRoot, "data.json")),
  };

  const { value, logs } = await captureArtifactServerLogs(async () => {
    console.debug(
      `artifact_call: loading server.js for ${input.command.app_name}`,
    );
    const api = await withArtifactServerTimeout({
      label: `loading server.js for ${input.command.app_name}`,
      callback: async () => await getServerApi({ serverPath, context }),
    });
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

    console.debug(
      `artifact_call: invoking ${input.command.function_name} for ${input.command.app_name}`,
    );
    const result = await withArtifactServerTimeout({
      label: `running ${input.command.function_name}`,
      callback: async () => await fn(input.command.args),
    });
    console.debug(
      `artifact_call: completed ${input.command.function_name} for ${input.command.app_name}`,
    );
    return toJsonSafeValue(result);
  });

  return { result: value, logs };
}
