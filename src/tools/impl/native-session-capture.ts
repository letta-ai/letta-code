import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiRequestError, apiRequest } from "@/backend/api/request";
import { getServerUrl, isCloudServerUrl } from "@/backend/api/server-url";
import { debugWarn } from "@/utils/debug";

export type NativeSessionSource = "claude_code" | "codex";
export interface NativeSessionScope {
  agentId: string;
  conversationId: string;
  actingUserId?: string;
}

interface CaptureState {
  scope: NativeSessionScope;
  path: string;
  /** Number of native bytes acknowledged by Cloud. */
  offset: number;
  chunkIndex: number;
  fileIdentity?: string;
  pending?: Promise<void>;
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

async function drain(
  state: CaptureState,
  source: NativeSessionSource,
  sessionId: string,
  requestOptions: { baseUrl?: string; apiKey?: string },
): Promise<void> {
  const handle = await open(state.path, "r").catch(() => undefined);
  if (!handle) return;
  try {
    const file = await handle.stat();
    if (!file.isFile()) return;
    const identity = `${file.dev}:${file.ino}`;
    if (state.fileIdentity && state.fileIdentity !== identity) return;
    state.fileIdentity = identity;
    // Snapshot EOF: app-server can continue writing while uploads are in flight.
    const end = file.size;
    if (end < state.offset) return; // Never replay bytes after truncation.
    while (state.offset < end) {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, end - state.offset));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        state.offset,
      );
      if (!bytesRead) return;
      const response = await apiRequest<{
        accepted_bytes: number;
        chunk_index: number;
      }>(
        "POST",
        `/v1/conversations/${encodeURIComponent(state.scope.conversationId)}/native-session/chunks`,
        {
          agent_id: state.scope.agentId,
          source,
          session_id: sessionId,
          chunk_index: state.chunkIndex,
          data_base64: buffer.subarray(0, bytesRead).toString("base64"),
        },
        {
          signal: AbortSignal.timeout(5_000),
          actingUserId: state.scope.actingUserId ?? null,
          ...requestOptions,
        },
      );
      if (
        response.chunk_index !== state.chunkIndex ||
        response.accepted_bytes !== bytesRead
      ) {
        throw new Error("Native session chunk acknowledgment mismatch");
      }
      state.offset += bytesRead;
      state.chunkIndex++;
    }
  } finally {
    await handle.close();
  }
}

/** Scope is captured at launch, never derived from process globals after a turn. */
export async function captureNativeSession(
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
    return;
  const id = key(source, sessionId);
  const existing = states.get(id);
  // Unknown resumed sessions may predate this process. A known native file
  // contains earlier turns, so never copy it into a different conversation
  // merely because that caller supplied the session UUID.
  if (!existing || !sameScope(existing.scope, scope)) return;
  if (existing.pending) {
    // A later turn can finish while the previous snapshot is still uploading.
    // Check its new EOF after the in-flight upload settles, even if it failed.
    await existing.pending.catch(() => undefined);
    return captureNativeSession(source, sessionId, scope, env, requestOptions);
  }
  // Preserve the conversation binding, but use the actor who ran this turn.
  // An in-flight drain retains its prior actor until it settles above.
  existing.scope = scope;
  // Claim the session synchronously, before the first filesystem await.
  existing.pending = (async () => {
    const path =
      existing.path || (await findNativeSessionPath(source, sessionId, env));
    if (!path) return;
    existing.path = path;
    await drain(existing, source, sessionId, requestOptions);
  })().finally(() => {
    existing.pending = undefined;
  });
  await existing.pending;
}

export function rememberNativeSession(
  source: NativeSessionSource,
  sessionId: string,
  scope: NativeSessionScope,
  cloudUrl = getServerUrl(),
): void {
  const id = key(source, sessionId);
  if (!states.has(id) && UUID.test(sessionId) && isCloudServerUrl(cloudUrl)) {
    states.set(id, { scope, path: "", offset: 0, chunkIndex: 0 });
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
