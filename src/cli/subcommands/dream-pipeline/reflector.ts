// Persistent "reflector" agent for the dream pipeline: one agent per primary
// agent, created lazily and reused across runs. Every batch reflection, merge
// stage, and aggregation pass runs as a FRESH CONVERSATION on this one agent
// (the deploy path spawns `--agent <id> --new`, so parallel batches never
// contend), instead of minting a throwaway agent per spawn. The reflector's
// conversation list therefore doubles as the dream run history, and recorded
// conversations are re-ingestable via the `letta:` trajectory source.
//
// The reflector is created with subagent semantics (hidden, no memory blocks,
// no memfs) — its working memory is always the fresh tree or worktree handed
// to each conversation via $MEMORY_DIR. A reflector is recreated when its
// stored model no longer matches the primary agent's (old ones are left
// behind; they are hidden and inert).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createAgent } from "@/agent/create";
import { getAllSubagentConfigs } from "@/agent/subagents";
import { getModelHandleFromAgent } from "@/agent/subagents/manager";
import { getBackend } from "@/backend";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import { debugWarn } from "@/utils/debug";
import { getDreamRootDir } from "./paths";

const REFLECTOR_STATE_SCHEMA_VERSION = "v1" as const;

interface DreamReflectorState {
  schema_version: typeof REFLECTOR_STATE_SCHEMA_VERSION;
  agentId: string;
  model: string | null;
  createdAt: string;
}

function reflectorStatePath(primaryAgentId: string): string {
  return join(getDreamRootDir(primaryAgentId), "reflector.json");
}

async function readReflectorState(
  primaryAgentId: string,
): Promise<DreamReflectorState | null> {
  let raw: string;
  try {
    raw = await readFile(reflectorStatePath(primaryAgentId), "utf-8");
  } catch {
    return null;
  }
  const parsed = safeJsonParseOr<Partial<DreamReflectorState> | null>(
    raw,
    null,
  );
  if (
    !parsed ||
    parsed.schema_version !== REFLECTOR_STATE_SCHEMA_VERSION ||
    typeof parsed.agentId !== "string"
  ) {
    return null;
  }
  return {
    schema_version: REFLECTOR_STATE_SCHEMA_VERSION,
    agentId: parsed.agentId,
    model: typeof parsed.model === "string" ? parsed.model : null,
    createdAt:
      typeof parsed.createdAt === "string"
        ? parsed.createdAt
        : new Date().toISOString(),
  };
}

async function primaryModelHandle(
  primaryAgentId: string,
): Promise<string | null> {
  try {
    const agent = await getBackend().retrieveAgent(primaryAgentId);
    return getModelHandleFromAgent(agent);
  } catch {
    return null;
  }
}

async function agentExists(agentId: string): Promise<boolean> {
  try {
    await getBackend().retrieveAgent(agentId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the reflector agent id for a primary agent, creating one when none
 * exists (or when the stored one vanished or its model drifted from the
 * primary's).
 */
export async function getOrCreateDreamReflector(params: {
  primaryAgentId: string;
  log?: (line: string) => void;
}): Promise<string> {
  const log = params.log ?? (() => {});
  const desiredModel = await primaryModelHandle(params.primaryAgentId);

  const existing = await readReflectorState(params.primaryAgentId);
  if (existing) {
    const modelMatches =
      desiredModel === null || existing.model === desiredModel;
    if (modelMatches && (await agentExists(existing.agentId))) {
      return existing.agentId;
    }
    if (!modelMatches) {
      log(
        `[reflector] model changed (${existing.model} → ${desiredModel}); creating a new reflector`,
      );
    }
  }

  const configs = await getAllSubagentConfigs();
  const reflectionPrompt = configs.reflection?.systemPrompt;
  if (!reflectionPrompt) {
    throw new Error("Builtin reflection subagent config not found");
  }

  const { agent: created } = await createAgent({
    name: "dream-reflector",
    description: `Dream pipeline reflector for ${params.primaryAgentId}`,
    systemPromptCustom: reflectionPrompt,
    ...(desiredModel ? { model: desiredModel } : {}),
    baseTools: [],
    tags: [
      "type:reflection",
      "role:dream-reflector",
      `parent:${params.primaryAgentId}`,
    ],
    asSubagent: true,
  });

  const state: DreamReflectorState = {
    schema_version: REFLECTOR_STATE_SCHEMA_VERSION,
    agentId: created.id,
    model: desiredModel,
    createdAt: new Date().toISOString(),
  };
  const statePath = reflectorStatePath(params.primaryAgentId);
  await mkdir(dirname(statePath), { recursive: true });
  try {
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to persist reflector state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  log(`[reflector] created ${created.id} (model ${desiredModel ?? "default"})`);
  return created.id;
}
