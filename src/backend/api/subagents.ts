import { resolveBackendMode } from "@/backend/backend-mode";
import { debugLog } from "@/utils/debug";
import { apiRequest } from "./request";
import { isCloudServerUrl } from "./server-url";

export type PersistedSubagentStatus =
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "stopped";

export interface SubagentLinks {
  agent_id?: string | null;
  conversation_id?: string | null;
  worker_session_id?: string | null;
}

interface SubagentUpdate extends SubagentLinks {
  status: PersistedSubagentStatus;
  archived?: boolean;
}

export interface SubagentSpawn extends SubagentLinks {
  description: string;
  prompt: string;
  harness: string;
  subagent_type: string | null;
  fork_context: boolean;
  model_config: Record<string, unknown> | null;
  computer: string | null;
  repositories: string[] | null;
  sandbox_size: string | null;
  mcp_config: Record<string, unknown> | null;
  parent_agent_id: string;
  parent_conversation_id: string;
  status: "running";
}

interface SubagentRecord extends SubagentUpdate {
  subagent_id: string;
  description: string;
  harness: string;
  subagent_type: string | null;
  created_at: string;
  updated_at: string;
}

export function usesCloudSubagents(): boolean {
  return resolveBackendMode() === "api" && isCloudServerUrl();
}

export function listCloudSubagentsPage(
  conversationId: string,
  actingUserId: string | null | undefined,
  options: {
    archived?: boolean;
    after?: string;
    limit: number;
    status?: PersistedSubagentStatus;
  },
): Promise<SubagentRecord[]> {
  return apiRequest("GET", "/v1/subagents", undefined, {
    actingUserId,
    signal: AbortSignal.timeout(15_000),
    query: {
      parent_conversation_id: conversationId,
      archived: options.archived ?? false,
      after: options.after,
      limit: options.limit,
      status: options.status,
    },
  });
}

async function listCloudSubagents(
  conversationId: string,
  actingUserId?: string | null,
  archived = false,
): Promise<SubagentRecord[]> {
  const records: SubagentRecord[] = [];
  let after: string | undefined;
  while (true) {
    const page = await listCloudSubagentsPage(conversationId, actingUserId, {
      archived,
      after,
      limit: 200,
    });
    records.push(...page);
    if (page.length < 200) return records;
    after = page.at(-1)?.subagent_id;
  }
}

export function queueSubagentUpdates(
  record: Promise<string | undefined>,
  update: (id: string, change: SubagentUpdate) => Promise<unknown>,
): (change: SubagentUpdate) => void {
  let pending = record.catch(() => {
    debugLog("subagents", "Could not resolve the persisted subagent");
    return undefined;
  });
  return (change) => {
    pending = pending.then(async (id) => {
      if (id) {
        try {
          await update(id, change);
        } catch {
          debugLog("subagents", "Could not update the persisted subagent");
        }
      }
      return id;
    });
  };
}

export function createSubagentWriter(
  input: SubagentSpawn,
  actingUserId?: string | null,
): (change: SubagentUpdate) => void {
  const record = apiRequest<SubagentRecord>(
    "POST",
    "/v1/subagents",
    { ...input },
    {
      actingUserId,
      signal: AbortSignal.timeout(15_000),
    },
  ).then((row) => row.subagent_id);
  return subagentWriter(record, actingUserId);
}

function subagentWriter(
  record: Promise<string | undefined>,
  actingUserId?: string | null,
): (change: SubagentUpdate) => void {
  return queueSubagentUpdates(record, (id, change) =>
    apiRequest(
      "PATCH",
      `/v1/subagents/${encodeURIComponent(id)}`,
      { ...change },
      {
        actingUserId,
        signal: AbortSignal.timeout(15_000),
      },
    ),
  );
}

export function resumeSubagentWriter(
  conversationId: string,
  target: Pick<SubagentLinks, "conversation_id" | "worker_session_id">,
  actingUserId?: string | null,
) {
  if (
    !usesCloudSubagents() ||
    conversationId === "default" ||
    (!target.conversation_id && !target.worker_session_id)
  )
    return undefined;
  const matches = (record: SubagentRecord) =>
    target.worker_session_id
      ? record.worker_session_id === target.worker_session_id
      : record.conversation_id === target.conversation_id;
  const record = (async () => {
    for (const archived of [false, true]) {
      const records = await listCloudSubagents(
        conversationId,
        actingUserId,
        archived,
      );
      const match = records
        .filter(matches)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
      if (match) return match.subagent_id;
    }
    return undefined;
  })();
  const update = subagentWriter(record, actingUserId);
  update({ status: "running", archived: false });
  return { update, found: record.then(Boolean, () => false) };
}
