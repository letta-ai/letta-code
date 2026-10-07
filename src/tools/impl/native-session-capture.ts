import { randomUUID } from "node:crypto";
import { type Dirent, readdirSync, rmSync } from "node:fs";
import {
  type FileHandle,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ApiRequestError, apiRequest } from "@/backend/api/request";
import { getServerUrl, isCloudServerUrl } from "@/backend/api/server-url";
import { debugWarn } from "@/utils/debug";

export type NativeSessionSource = "claude_code" | "codex";
export interface NativeSessionScope {
  agentId: string;
  conversationId: string;
  actingUserId?: string | null;
}
interface Segment {
  scope: NativeSessionScope;
  start: number;
  end: number;
  path: string;
  requestOptions: { baseUrl?: string; apiKey?: string };
}
interface CaptureState {
  scope: NativeSessionScope;
  path: string;
  ackedOffset: number;
  sealedOffset: number;
  chunkIndex: number;
  fileIdentity?: string;
  sealing: Promise<void>;
  draining?: Promise<void>;
  drainError?: unknown;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryDelayMs: number;
  segments: Segment[];
}
const states = new Map<string, CaptureState>();
const spoolDirectories = new Set<string>();
const captureProcessInstanceId = randomUUID();
const activeInstanceRegistryKey = Symbol.for(
  "letta.native-session-capture.active-instances",
);
const activeCaptureInstances = (() => {
  const globalRegistry = globalThis as typeof globalThis & {
    [activeInstanceRegistryKey]?: Set<string>;
  };
  globalRegistry[activeInstanceRegistryKey] ??= new Set<string>();
  return globalRegistry[activeInstanceRegistryKey];
})();
activeCaptureInstances.add(captureProcessInstanceId);
const spoolDirectoryName = /^letta-native-session-(\d+)-([0-9a-f-]{36})-/;
let staleSpoolsScavenged = false;
let sealHookForTests: (() => Promise<void>) | undefined;
export const NATIVE_SESSION_CAPTURE_CHUNK_BYTES = 256 * 1024;
const INITIAL_DRAIN_RETRY_MS = 250;
const MAX_DRAIN_RETRY_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanupSpoolDirectorySync(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  spoolDirectories.delete(directory);
}

function scavengeStaleSpoolDirectories(): void {
  if (staleSpoolsScavenged) return;
  staleSpoolsScavenged = true;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(spoolDirectoryName);
    if (!match) continue;
    const ownerPid = Number(match[1]);
    const ownerInstanceId = match[2];
    let ownerIsAlive = true;
    if (ownerPid === process.pid) {
      ownerIsAlive = activeCaptureInstances.has(ownerInstanceId ?? "");
    } else {
      try {
        process.kill(ownerPid, 0);
      } catch (error) {
        ownerIsAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    }
    if (!ownerIsAlive) cleanupSpoolDirectorySync(join(tmpdir(), entry.name));
  }
}

process.once("exit", () => {
  activeCaptureInstances.delete(captureProcessInstanceId);
  for (const directory of [...spoolDirectories]) {
    cleanupSpoolDirectorySync(directory);
  }
});
function key(source: NativeSessionSource, sessionId: string) {
  return `${source}:${sessionId}`;
}
function sameScope(a: NativeSessionScope, b: NativeSessionScope) {
  return a.agentId === b.agentId && a.conversationId === b.conversationId;
}

async function entries(path: string, directories: boolean): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => (directories ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}
/** Find the exact native file for a CLI session, not a stdout projection. */
export async function findNativeSessionPath(
  source: NativeSessionSource,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (!UUID.test(sessionId)) return undefined;
  const home = env.HOME || homedir();
  if (source === "claude_code") {
    const projects = join(
      env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
      "projects",
    );
    for (const project of await entries(projects, true)) {
      const path = join(projects, project, `${sessionId}.jsonl`);
      try {
        if ((await stat(path)).isFile()) return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return undefined;
  }
  const root = join(env.CODEX_HOME || join(home, ".codex"), "sessions");
  for (const year of (await entries(root, true)).filter((name) =>
    /^\d{4}$/.test(name),
  ))
    for (const month of (await entries(join(root, year), true)).filter((name) =>
      /^\d{2}$/.test(name),
    ))
      for (const day of (await entries(join(root, year, month), true)).filter(
        (name) => /^\d{2}$/.test(name),
      )) {
        const directory = join(root, year, month, day);
        for (const file of await entries(directory, false))
          if (
            file.startsWith("rollout-") &&
            file.endsWith(`-${sessionId}.jsonl`)
          )
            return join(directory, file);
      }
  return undefined;
}

async function seal(
  state: CaptureState,
  source: NativeSessionSource,
  sessionId: string,
  scope: NativeSessionScope,
  env: NodeJS.ProcessEnv,
  requestOptions: { baseUrl?: string; apiKey?: string },
): Promise<void> {
  const path =
    state.path || (await findNativeSessionPath(source, sessionId, env));
  if (!path) {
    throw new Error("Native session file was not found before EOF capture");
  }
  let input: FileHandle;
  try {
    input = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Native session file disappeared before EOF capture");
    throw error;
  }
  const directory = await mkdtemp(
    join(
      tmpdir(),
      `letta-native-session-${process.pid}-${captureProcessInstanceId}-`,
    ),
  );
  spoolDirectories.add(directory);
  const spoolPath = join(directory, "segment");
  let output: FileHandle | undefined;
  let retained = false;
  try {
    const before = await input.stat();
    if (!before.isFile())
      throw new Error("Native session capture source is not a file");
    if (before.size < state.sealedOffset)
      throw new Error("Native session file was truncated before capture");
    const identity = `${before.dev}:${before.ino}`;
    if (state.fileIdentity && state.fileIdentity !== identity)
      throw new Error("Native session capture changed file identity");
    const start = state.sealedOffset;
    const end = before.size;
    await sealHookForTests?.();
    output = await open(spoolPath, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(NATIVE_SESSION_CAPTURE_CHUNK_BYTES);
    let position = start;
    while (position < end) {
      const length = Math.min(buffer.length, end - position);
      const { bytesRead } = await input.read(buffer, 0, length, position);
      if (bytesRead !== length)
        throw new Error("Native session changed during EOF capture");
      let written = 0;
      while (written < bytesRead)
        written += (
          await output.write(buffer, written, bytesRead - written, null)
        ).bytesWritten;
      position += bytesRead;
    }
    const after = await input.stat();
    if (
      `${after.dev}:${after.ino}` !== identity ||
      after.size !== before.size ||
      after.ctimeMs !== before.ctimeMs ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error("Native session changed during EOF capture");
    state.path = path;
    state.fileIdentity = identity;
    if (end > state.sealedOffset) {
      state.segments.push({
        scope: { ...scope },
        start,
        end,
        path: spoolPath,
        requestOptions: { ...requestOptions },
      });
      state.sealedOffset = end;
      retained = true;
    }
  } finally {
    await input.close();
    await output?.close();
    if (!retained) {
      await rm(directory, { recursive: true, force: true });
      spoolDirectories.delete(directory);
    }
  }
}

async function drain(
  state: CaptureState,
  source: NativeSessionSource,
  sessionId: string,
): Promise<void> {
  while (state.segments.length) {
    const segment = state.segments[0];
    if (!segment) return;
    const spool = await open(segment.path, "r");
    try {
      while (state.ackedOffset < segment.end) {
        if (state.ackedOffset < segment.start)
          throw new Error("Native session segment has an unrecorded byte gap");
        const length = Math.min(
          NATIVE_SESSION_CAPTURE_CHUNK_BYTES,
          segment.end - state.ackedOffset,
        );
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await spool.read(
          buffer,
          0,
          length,
          state.ackedOffset - segment.start,
        );
        if (bytesRead !== length)
          throw new Error("Native session spool ended before its sealed EOF");
        const response = await apiRequest<{
          accepted_bytes: number;
          chunk_index: number;
        }>(
          "POST",
          `/v1/conversations/${encodeURIComponent(segment.scope.conversationId)}/native-session/chunks`,
          {
            agent_id: segment.scope.agentId,
            source,
            session_id: sessionId,
            chunk_index: state.chunkIndex,
            data_base64: buffer.toString("base64"),
          },
          {
            signal: AbortSignal.timeout(5_000),
            actingUserId: segment.scope.actingUserId,
            ...segment.requestOptions,
          },
        );
        if (
          response.chunk_index !== state.chunkIndex ||
          response.accepted_bytes !== length
        )
          throw new Error("Native session chunk acknowledgment mismatch");
        state.ackedOffset += length;
        state.chunkIndex++;
      }
    } finally {
      await spool.close();
    }
    state.segments.shift();
    const directory = join(segment.path, "..");
    await rm(directory, { recursive: true, force: true });
    spoolDirectories.delete(directory);
  }
}

function startDrain(
  state: CaptureState,
  source: NativeSessionSource,
  sessionId: string,
): void {
  if (state.draining || !state.segments.length) return;
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
  }
  state.drainError = undefined;
  const running = drain(state, source, sessionId);
  state.draining = running;
  let failed = false;
  void running
    .catch((error) => {
      failed = true;
      state.drainError = error;
      reportNativeSessionCaptureFailure(source, sessionId, error);
      if (!state.retryTimer) {
        const delayMs = state.retryDelayMs;
        state.retryDelayMs = Math.min(
          MAX_DRAIN_RETRY_MS,
          state.retryDelayMs * 2,
        );
        state.retryTimer = setTimeout(() => {
          state.retryTimer = undefined;
          startDrain(state, source, sessionId);
        }, delayMs);
        state.retryTimer.unref?.();
      }
    })
    .finally(() => {
      if (state.draining === running) state.draining = undefined;
      if (!failed && state.segments.length) {
        startDrain(state, source, sessionId);
      } else if (!failed) {
        state.retryDelayMs = INITIAL_DRAIN_RETRY_MS;
      }
    });
}

/** Resolves once the turn's bytes are immutable on disk; network drain is background work. */
export function captureNativeSession(
  source: NativeSessionSource,
  sessionId: string,
  scope: NativeSessionScope | undefined,
  env: NodeJS.ProcessEnv = process.env,
  requestOptions: { baseUrl?: string; apiKey?: string; cloudUrl?: string } = {},
): Promise<void> {
  if (
    !scope?.agentId ||
    !scope.conversationId ||
    !isCloudServerUrl(requestOptions.cloudUrl ?? getServerUrl()) ||
    !UUID.test(sessionId)
  )
    return Promise.resolve();
  const state = states.get(key(source, sessionId));
  if (!state || !sameScope(state.scope, scope)) return Promise.resolve();
  const frozenScope = { ...scope };
  const frozenOptions = {
    baseUrl: requestOptions.baseUrl,
    apiKey: requestOptions.apiKey,
  };
  const sealing = state.sealing.then(() =>
    seal(state, source, sessionId, frozenScope, env, frozenOptions),
  );
  // A failed seal poisons this process-owned session. Advancing to a later
  // reservation would permanently skip bytes whose actor could not be frozen.
  state.sealing = sealing;
  return sealing.then(() => startDrain(state, source, sessionId));
}

export async function awaitNativeSessionCaptureDrainForTests(
  source?: NativeSessionSource,
  sessionId?: string,
): Promise<void> {
  const selected =
    source && sessionId
      ? [states.get(key(source, sessionId))].filter(
          (value): value is CaptureState => Boolean(value),
        )
      : [...states.values()];
  for (const state of selected) {
    await state.sealing;
    if (source && sessionId) startDrain(state, source, sessionId);
    await state.draining?.catch(() => undefined);
    if (state.drainError) throw state.drainError;
  }
}

export function rememberNativeSession(
  source: NativeSessionSource,
  sessionId: string,
  scope: NativeSessionScope,
  cloudUrl = getServerUrl(),
): void {
  scavengeStaleSpoolDirectories();
  const id = key(source, sessionId);
  if (!states.has(id) && UUID.test(sessionId) && isCloudServerUrl(cloudUrl))
    states.set(id, {
      scope: { ...scope },
      path: "",
      ackedOffset: 0,
      sealedOffset: 0,
      chunkIndex: 0,
      sealing: Promise.resolve(),
      retryDelayMs: INITIAL_DRAIN_RETRY_MS,
      segments: [],
    });
}

export async function clearNativeSessionCaptureForTests(): Promise<void> {
  sealHookForTests = undefined;
  const captured = [...states.values()];
  states.clear();
  for (const state of captured) {
    if (state.retryTimer) clearTimeout(state.retryTimer);
    await state.sealing.catch(() => undefined);
    await state.draining?.catch(() => undefined);
    if (state.retryTimer) clearTimeout(state.retryTimer);
    for (const segment of state.segments) {
      const directory = join(segment.path, "..");
      await rm(directory, { recursive: true, force: true });
      spoolDirectories.delete(directory);
    }
  }
}

export function setNativeSessionCaptureSealHookForTests(
  hook: (() => Promise<void>) | undefined,
): void {
  sealHookForTests = hook;
}

/** Report delivery failure without logging raw transcripts or response bodies. */
export function reportNativeSessionCaptureFailure(
  source: NativeSessionSource,
  sessionId: string,
  error: unknown,
): void {
  const reason =
    error instanceof ApiRequestError
      ? `HTTP ${error.status}`
      : error instanceof Error
        ? error.name
        : "unknown error";
  debugWarn(
    "native-session",
    `${source} ${sessionId}: upload failed (${reason})`,
  );
}
