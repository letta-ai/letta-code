import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
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

interface CaptureState {
  scope: NativeSessionScope;
  path: string;
  /** Number of native bytes acknowledged by Cloud. */
  offset: number;
  chunkIndex: number;
  fileIdentity?: string;
  pending?: Promise<void>;
  snapshots: CaptureSnapshot[];
}

interface CaptureSnapshot {
  scope: NativeSessionScope;
  start: number;
  end: number;
  fileIdentity: string;
  bytes: Buffer;
}

const states = new Map<string, CaptureState>();

const CHUNK_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function key(source: NativeSessionSource, sessionId: string): string {
  return `${source}:${sessionId}`;
}

function sameScope(a: NativeSessionScope, b: NativeSessionScope): boolean {
  return a.agentId === b.agentId && a.conversationId === b.conversationId;
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
    // Claude's --session-id/--resume writes one JSONL under its project directory.
    const projects = join(
      env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
      "projects",
    );
    for (const project of await readdir(projects, {
      withFileTypes: true,
    }).catch(() => [])) {
      if (!project.isDirectory()) continue;
      const path = join(projects, project.name, `${sessionId}.jsonl`);
      if ((await stat(path).catch(() => undefined))?.isFile()) return path;
    }
    return undefined;
  }
  // Codex app-server rollouts nest under sessions/YYYY/MM/DD; filename embeds
  // the native thread UUID returned by thread/start.
  const root = join(env.CODEX_HOME || join(home, ".codex"), "sessions");
  for (const year of await readdir(root, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    for (const month of await readdir(join(root, year.name), {
      withFileTypes: true,
    }).catch(() => [])) {
      if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
      for (const day of await readdir(join(root, year.name, month.name), {
        withFileTypes: true,
      }).catch(() => [])) {
        if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
        const directory = join(root, year.name, month.name, day.name);
        for (const file of await readdir(directory, {
          withFileTypes: true,
        }).catch(() => [])) {
          if (
            file.isFile() &&
            file.name.startsWith("rollout-") &&
            file.name.endsWith(`-${sessionId}.jsonl`)
          ) {
            return join(directory, file.name);
          }
        }
      }
    }
  }
  return undefined;
}

function findNativeSessionPathSync(
  source: NativeSessionSource,
  sessionId: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!UUID.test(sessionId)) return undefined;
  const home = env.HOME || homedir();
  if (source === "claude_code") {
    const projects = join(
      env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
      "projects",
    );
    for (const project of safeReadDirectories(projects)) {
      const path = join(projects, project, `${sessionId}.jsonl`);
      if (snapshotFile(path)) return path;
    }
    return undefined;
  }
  const root = join(env.CODEX_HOME || join(home, ".codex"), "sessions");
  for (const year of safeReadDirectories(root).filter((name) =>
    /^\d{4}$/.test(name),
  )) {
    for (const month of safeReadDirectories(join(root, year)).filter((name) =>
      /^\d{2}$/.test(name),
    )) {
      for (const day of safeReadDirectories(join(root, year, month)).filter(
        (name) => /^\d{2}$/.test(name),
      )) {
        const directory = join(root, year, month, day);
        for (const file of safeReadFiles(directory)) {
          if (
            file.startsWith("rollout-") &&
            file.endsWith(`-${sessionId}.jsonl`)
          )
            return join(directory, file);
        }
      }
    }
  }
  return undefined;
}

function safeReadDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function safeReadFiles(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function snapshotFile(path: string, start = 0, captureBytes = false) {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const file = fstatSync(descriptor);
    if (!file.isFile()) return undefined;
    if (file.size < start) {
      throw new Error("Native session file was truncated before capture");
    }
    const end = file.size;
    const bytes = Buffer.alloc(captureBytes ? end - start : 0);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        start + offset,
      );
      if (!read) {
        throw new Error("Native session changed during EOF capture");
      }
      offset += read;
    }
    const completed = fstatSync(descriptor);
    if (
      completed.dev !== file.dev ||
      completed.ino !== file.ino ||
      completed.size < end ||
      completed.ctimeMs !== file.ctimeMs ||
      completed.mtimeMs !== file.mtimeMs
    ) {
      throw new Error("Native session changed during EOF capture");
    }
    return {
      start,
      end,
      fileIdentity: `${file.dev}:${file.ino}`,
      bytes,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function drain(
  state: CaptureState,
  snapshot: CaptureSnapshot,
  source: NativeSessionSource,
  sessionId: string,
  requestOptions: { baseUrl?: string; apiKey?: string },
): Promise<void> {
  if (state.fileIdentity && state.fileIdentity !== snapshot.fileIdentity) {
    throw new Error("Native session capture changed file identity");
  }
  state.fileIdentity = snapshot.fileIdentity;
  if (state.offset < snapshot.start) {
    throw new Error("Native session snapshot has an unrecorded byte gap");
  }
  while (state.offset < snapshot.end) {
    const relativeOffset = state.offset - snapshot.start;
    const buffer = snapshot.bytes.subarray(
      relativeOffset,
      Math.min(snapshot.bytes.length, relativeOffset + CHUNK_BYTES),
    );
    if (buffer.length === 0) {
      throw new Error("Native session snapshot ended before its captured EOF");
    }
    const response = await apiRequest<{
      accepted_bytes: number;
      chunk_index: number;
    }>(
      "POST",
      `/v1/conversations/${encodeURIComponent(snapshot.scope.conversationId)}/native-session/chunks`,
      {
        agent_id: snapshot.scope.agentId,
        source,
        session_id: sessionId,
        chunk_index: state.chunkIndex,
        data_base64: buffer.toString("base64"),
      },
      {
        signal: AbortSignal.timeout(5_000),
        actingUserId: snapshot.scope.actingUserId,
        ...requestOptions,
      },
    );
    if (
      response.chunk_index !== state.chunkIndex ||
      response.accepted_bytes !== buffer.length
    ) {
      throw new Error("Native session chunk acknowledgment mismatch");
    }
    state.offset += buffer.length;
    state.chunkIndex++;
  }
}

async function drainSnapshots(
  state: CaptureState,
  source: NativeSessionSource,
  sessionId: string,
  requestOptions: { baseUrl?: string; apiKey?: string },
): Promise<void> {
  while (state.snapshots.length > 0) {
    const snapshot = state.snapshots[0];
    if (!snapshot) return;
    await drain(state, snapshot, source, sessionId, requestOptions);
    if (state.snapshots[0] === snapshot) state.snapshots.shift();
  }
}

/** Scope is captured at launch, never derived from process globals after a turn. */
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
  const id = key(source, sessionId);
  const existing = states.get(id);
  // Unknown resumed sessions may predate this process. A known native file
  // contains earlier turns, so never copy it into a different conversation
  // merely because that caller supplied the session UUID.
  if (!existing || !sameScope(existing.scope, scope)) return Promise.resolve();
  const path =
    existing.path || findNativeSessionPathSync(source, sessionId, env);
  if (!path) return Promise.resolve();
  let boundary: ReturnType<typeof snapshotFile>;
  try {
    boundary = snapshotFile(path, existing.offset, true);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!boundary) return Promise.resolve();
  existing.path = path;
  const snapshot: CaptureSnapshot = { scope, ...boundary };
  existing.snapshots.push(snapshot);
  const prior = existing.pending;
  const pending = (
    prior ? prior.catch(() => undefined) : Promise.resolve()
  ).then(() => drainSnapshots(existing, source, sessionId, requestOptions));
  let tracked: Promise<void>;
  tracked = pending.finally(() => {
    if (existing.pending === tracked) existing.pending = undefined;
  });
  existing.pending = tracked;
  return tracked;
}

export function rememberNativeSession(
  source: NativeSessionSource,
  sessionId: string,
  scope: NativeSessionScope,
  cloudUrl = getServerUrl(),
): void {
  const id = key(source, sessionId);
  if (!states.has(id) && UUID.test(sessionId) && isCloudServerUrl(cloudUrl)) {
    states.set(id, {
      scope,
      path: "",
      offset: 0,
      chunkIndex: 0,
      snapshots: [],
    });
  }
}

export function clearNativeSessionCaptureForTests(): void {
  states.clear();
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
