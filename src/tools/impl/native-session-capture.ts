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
  localRetryCount?: number;
  uploadedOffset?: number;
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
  requiresBoundaryReset?: boolean;
}
interface NativeCaptureAdmission {
  source: NativeSessionSource;
  sessionId: string;
  scope: NativeSessionScope;
  env: NodeJS.ProcessEnv;
  requestOptions: { baseUrl?: string; apiKey?: string; cloudUrl?: string };
  done: Promise<void>;
  release: () => void;
}

class NativeChunkAcknowledgmentError extends Error {
  constructor(readonly attemptedChunkIndex: number) {
    super("Native session chunk acknowledgment mismatch");
  }
}

class NativeSessionSourceGrowthError extends Error {
  constructor() {
    super("Native session grew during EOF capture");
  }
}

export interface NativeSessionCaptureReservation {
  capture(): Promise<void>;
}
const states = new Map<string, CaptureState>();
const admissions = new Map<string, NativeCaptureAdmission>();
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
let drainHookForTests: (() => Promise<void>) | undefined;
export const NATIVE_SESSION_CAPTURE_CHUNK_BYTES = 256 * 1024;
const INITIAL_DRAIN_RETRY_MS = 250;
const MAX_DRAIN_RETRY_MS = 30_000;
const SEAL_RETRY_DELAYS_MS = [0, 10, 50, 250, 1_000] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanupSpoolDirectorySync(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  spoolDirectories.delete(directory);
}

async function cleanupSpoolDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
    spoolDirectories.delete(directory);
  } catch (error) {
    debugWarn(
      "native-session",
      "Failed to delete native capture spool directory",
      error,
    );
  }
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

async function captureAdmission(
  admission: NativeCaptureAdmission,
): Promise<void> {
  let failure: unknown;
  for (const delayMs of SEAL_RETRY_DELAYS_MS) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      await captureNativeSession(
        admission.source,
        admission.sessionId,
        admission.scope,
        admission.env,
        admission.requestOptions,
      );
      admission.release();
      return;
    } catch (error) {
      failure = error;
      if (!retryableSealFailure(error)) break;
    }
  }
  try {
    await retireFailedCaptureSession(admission);
  } finally {
    admission.release();
  }
  throw failure;
}

async function retireFailedCaptureSession(
  admission: NativeCaptureAdmission,
): Promise<void> {
  const id = key(admission.source, admission.sessionId);
  const state = states.get(id);
  if (!state) return;
  if (state.retryTimer) clearTimeout(state.retryTimer);
  await state.draining?.catch(() => undefined);
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.requiresBoundaryReset = true;
  try {
    await resetCaptureBoundary(
      state,
      admission.source,
      admission.sessionId,
      admission.env,
    );
  } catch {
    // Keep the remembered state fenced. A later reservation must establish a
    // verified EOF drop boundary before another actor may start.
  }
}

async function resetCaptureBoundary(
  state: CaptureState,
  source: NativeSessionSource,
  sessionId: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let path = state.path;
  let input: FileHandle;
  try {
    if (!path) {
      const discovered = await findNativeSessionPath(source, sessionId, env);
      if (!discovered)
        throw new Error("Native session file was not found for boundary reset");
      path = discovered;
    }
    input = await open(path, "r");
  } catch (error) {
    if (!state.path) throw error;
    const discovered = await findNativeSessionPath(source, sessionId, env);
    if (!discovered || discovered === state.path) throw error;
    path = discovered;
    input = await open(path, "r");
  }
  const snapshot = await (async () => {
    try {
      const value = await input.stat();
      if (!value.isFile())
        throw new Error("Native session source is not a file");
      return value;
    } finally {
      await input.close();
    }
  })();
  state.path = path;
  if (state.segments.length === 0) state.ackedOffset = snapshot.size;
  state.sealedOffset = snapshot.size;
  state.fileIdentity = `${snapshot.dev}:${snapshot.ino}`;
  state.drainError = undefined;
  state.retryDelayMs = INITIAL_DRAIN_RETRY_MS;
  state.requiresBoundaryReset = false;
}

export async function reserveNativeSessionCapture(
  source: NativeSessionSource,
  sessionId: string,
  scope: NativeSessionScope,
  env: NodeJS.ProcessEnv = process.env,
  requestOptions: { baseUrl?: string; apiKey?: string; cloudUrl?: string } = {},
): Promise<NativeSessionCaptureReservation> {
  const id = key(source, sessionId);
  while (true) {
    const active = admissions.get(id);
    if (active) {
      await active.done;
      continue;
    }
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admission: NativeCaptureAdmission = {
      source,
      sessionId,
      scope: { ...scope },
      env: { ...env },
      requestOptions: { ...requestOptions },
      done,
      release: () => {
        if (admissions.get(id) === admission) admissions.delete(id);
        release();
      },
    };
    admissions.set(id, admission);
    const state = states.get(id);
    if (state?.requiresBoundaryReset) {
      try {
        await resetCaptureBoundary(state, source, sessionId, env);
      } catch (error) {
        // Capture is auxiliary. Keep this actor's admission/fence, but allow
        // the native turn to recreate or relocate its session file; the EOF
        // finalizer will retry the reset without bricking every later send.
        reportNativeSessionCaptureFailure(source, sessionId, error);
      }
    }
    let settled = false;
    return {
      async capture() {
        if (settled) return;
        settled = true;
        await captureAdmission(admission);
      },
    };
  }
}

function retryableSealFailure(error: unknown): boolean {
  if (error instanceof NativeSessionSourceGrowthError) return true;
  const code =
    (error as NodeJS.ErrnoException)?.code ??
    (error as { cause?: NodeJS.ErrnoException })?.cause?.code;
  return Boolean(
    code && ["EBUSY", "EINTR", "EIO", "EMFILE", "ENFILE"].includes(code),
  );
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
    const afterIdentity = `${after.dev}:${after.ino}`;
    if (afterIdentity === identity && after.size > before.size) {
      throw new NativeSessionSourceGrowthError();
    }
    if (
      afterIdentity !== identity ||
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
      await cleanupSpoolDirectory(directory);
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
    await drainHookForTests?.();
    const spool = await open(segment.path, "r");
    try {
      let uploadedOffset = segment.uploadedOffset ?? segment.start;
      while (uploadedOffset < segment.end) {
        const length = Math.min(
          NATIVE_SESSION_CAPTURE_CHUNK_BYTES,
          segment.end - uploadedOffset,
        );
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await spool.read(
          buffer,
          0,
          length,
          uploadedOffset - segment.start,
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
          throw new NativeChunkAcknowledgmentError(state.chunkIndex);
        uploadedOffset += length;
        segment.uploadedOffset = uploadedOffset;
        state.ackedOffset = uploadedOffset;
        state.chunkIndex++;
      }
    } finally {
      await spool.close();
    }
    state.segments.shift();
    const directory = join(segment.path, "..");
    await cleanupSpoolDirectory(directory);
  }
}

function retryableDrainFailure(error: unknown): boolean {
  if (error instanceof ApiRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return true;
  }
  const code =
    (error as NodeJS.ErrnoException)?.code ??
    (
      error as {
        cause?: NodeJS.ErrnoException;
      }
    )?.cause?.code;
  return Boolean(
    code &&
      [
        "EAI_AGAIN",
        "ECONNABORTED",
        "ECONNREFUSED",
        "ECONNRESET",
        "EHOSTUNREACH",
        "EINTR",
        "ENETDOWN",
        "ENETUNREACH",
        "ETIMEDOUT",
      ].includes(code),
  );
}

function retryableLocalSpoolFailure(error: unknown): boolean {
  const code =
    (error as NodeJS.ErrnoException)?.code ??
    (error as { cause?: NodeJS.ErrnoException })?.cause?.code;
  return Boolean(
    code && ["EBUSY", "EINTR", "EIO", "EMFILE", "ENFILE"].includes(code),
  );
}

async function discardRejectedSegment(state: CaptureState): Promise<void> {
  const segment = state.segments.shift();
  if (!segment) return;
  const directory = join(segment.path, "..");
  await cleanupSpoolDirectory(directory);
  // Only the head segment was rejected. Later segments can belong to other
  // actors and must each receive their own upload attempt.
  state.ackedOffset = segment.end;
  state.retryDelayMs = INITIAL_DRAIN_RETRY_MS;
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
  let continueAfterFailure = false;
  void running
    .catch(async (error) => {
      failed = true;
      state.drainError = error;
      reportNativeSessionCaptureFailure(source, sessionId, error);
      const segment = state.segments[0];
      if (error instanceof NativeChunkAcknowledgmentError) {
        // The server may have committed the attempted index before returning a
        // malformed response. Never reuse that ambiguous idempotency slot for
        // another actor's bytes.
        state.chunkIndex = Math.max(
          state.chunkIndex,
          error.attemptedChunkIndex + 1,
        );
      }
      const retryableLocal = retryableLocalSpoolFailure(error);
      if (retryableLocal && segment) {
        segment.localRetryCount = (segment.localRetryCount ?? 0) + 1;
      }
      if (
        (!retryableLocal && !retryableDrainFailure(error)) ||
        (retryableLocal && (segment?.localRetryCount ?? 0) > 5)
      ) {
        await discardRejectedSegment(state);
        continueAfterFailure = state.segments.length > 0;
        return;
      }
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
      if ((!failed || continueAfterFailure) && state.segments.length) {
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
  const sealing = state.sealing
    .catch(() => undefined)
    .then(() =>
      seal(state, source, sessionId, frozenScope, env, frozenOptions),
    );
  // Production callers hold a per-session admission until this actor's exact
  // boundary succeeds. Keep the queue usable for that same reservation's
  // bounded retry rather than poisoning every future attempt in the process.
  state.sealing = sealing.catch(() => undefined);
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
  drainHookForTests = undefined;
  const captured = [...states.values()];
  states.clear();
  for (const admission of admissions.values()) admission.release();
  admissions.clear();
  for (const state of captured) {
    if (state.retryTimer) clearTimeout(state.retryTimer);
    await state.sealing.catch(() => undefined);
    await state.draining?.catch(() => undefined);
    if (state.retryTimer) clearTimeout(state.retryTimer);
    for (const segment of state.segments) {
      const directory = join(segment.path, "..");
      await cleanupSpoolDirectory(directory);
    }
  }
}

export function setNativeSessionCaptureSealHookForTests(
  hook: (() => Promise<void>) | undefined,
): void {
  sealHookForTests = hook;
}

export function setNativeSessionCaptureDrainHookForTests(
  hook: (() => Promise<void>) | undefined,
): void {
  drainHookForTests = hook;
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
