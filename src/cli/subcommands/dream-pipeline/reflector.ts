// Persistent worker agents for the dream pipeline, one pair per primary
// agent, created lazily and reused across runs:
//
// - The REFLECTOR carries the builtin reflection system prompt; every batch
//   reflection runs as a FRESH CONVERSATION on it (the deploy path spawns
//   `--agent <id> --new`, so parallel batches never contend).
// - The AGGREGATOR carries the default letta-code system prompt with the
//   aggregator persona block (matching the batch-reflection prototype); the
//   aggregation pass runs as a fresh conversation on it.
//
// A worker's conversation list therefore doubles as the dream run history,
// and recorded conversations are re-ingestable via the `letta:` trajectory
// source. Workers are created with subagent semantics (hidden, no memfs) —
// their working memory is always the fresh tree or worktree handed to each
// conversation via $MEMORY_DIR.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CreateAgentOptions, createAgent } from "@/agent/create";
import { getAllSubagentConfigs } from "@/agent/subagents";
import { getModelHandleFromAgent } from "@/agent/subagents/manager";
import { getBackend } from "@/backend";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import { debugWarn } from "@/utils/debug";
import { getDreamRootDir } from "./paths";
import { AGGREGATOR_PERSONA } from "./prompts";

const WORKER_STATE_SCHEMA_VERSION = "v1" as const;

interface DreamWorkerState {
  schema_version: typeof WORKER_STATE_SCHEMA_VERSION;
  agentId: string;
}

async function readWorkerAgentId(statePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf-8");
  } catch {
    return null;
  }
  const parsed = safeJsonParseOr<Partial<DreamWorkerState> | null>(raw, null);
  if (
    !parsed ||
    parsed.schema_version !== WORKER_STATE_SCHEMA_VERSION ||
    typeof parsed.agentId !== "string"
  ) {
    return null;
  }
  return parsed.agentId;
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

async function getOrCreateDreamWorker(params: {
  primaryAgentId: string;
  stateFileName: string;
  logLabel: string;
  createOptions: () => Promise<CreateAgentOptions> | CreateAgentOptions;
  log?: (line: string) => void;
}): Promise<string> {
  const log = params.log ?? (() => {});
  const statePath = join(
    getDreamRootDir(params.primaryAgentId),
    params.stateFileName,
  );

  const existingAgentId = await readWorkerAgentId(statePath);
  if (existingAgentId && (await agentExists(existingAgentId))) {
    return existingAgentId;
  }

  // Match the primary agent's model at creation time.
  const desiredModel = await primaryModelHandle(params.primaryAgentId);
  const { agent: created } = await createAgent({
    ...(await params.createOptions()),
    ...(desiredModel ? { model: desiredModel } : {}),
    baseTools: [],
    asSubagent: true,
  });

  const state: DreamWorkerState = {
    schema_version: WORKER_STATE_SCHEMA_VERSION,
    agentId: created.id,
  };
  await mkdir(dirname(statePath), { recursive: true });
  try {
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to persist ${params.logLabel} state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  log(
    `[${params.logLabel}] created ${created.id} (model ${desiredModel ?? "default"})`,
  );
  return created.id;
}

/**
 * Return the reflector agent id for a primary agent, creating one when none
 * exists (or the stored one vanished).
 */
export async function getOrCreateDreamReflector(params: {
  primaryAgentId: string;
  log?: (line: string) => void;
}): Promise<string> {
  return getOrCreateDreamWorker({
    primaryAgentId: params.primaryAgentId,
    stateFileName: "reflector.json",
    logLabel: "reflector",
    log: params.log,
    createOptions: async () => {
      const configs = await getAllSubagentConfigs();
      const reflectionPrompt = configs.reflection?.systemPrompt;
      if (!reflectionPrompt) {
        throw new Error("Builtin reflection subagent config not found");
      }
      return {
        name: "dream-reflector",
        description: `Dream pipeline reflector for ${params.primaryAgentId}`,
        systemPromptCustom: reflectionPrompt,
        tags: [
          "type:reflection",
          "role:dream-reflector",
          `parent:${params.primaryAgentId}`,
        ],
      };
    },
  });
}

/**
 * Return the aggregator agent id for a primary agent. Matches the prototype's
 * setup: the DEFAULT letta-code system prompt with the aggregator persona as
 * its persona memory block.
 */
export async function getOrCreateDreamAggregator(params: {
  primaryAgentId: string;
  log?: (line: string) => void;
}): Promise<string> {
  return getOrCreateDreamWorker({
    primaryAgentId: params.primaryAgentId,
    stateFileName: "aggregator.json",
    logLabel: "aggregator",
    log: params.log,
    createOptions: () => ({
      name: "dream-aggregator",
      description: `Dream pipeline aggregator for ${params.primaryAgentId}`,
      memoryBlocks: [
        {
          label: "persona",
          value: AGGREGATOR_PERSONA,
          description:
            "Who I am: a memory aggregator agent merging reflection outputs into one cohesive memory filesystem.",
        },
      ],
      tags: [
        "type:aggregation",
        "role:dream-aggregator",
        `parent:${params.primaryAgentId}`,
      ],
    }),
  });
}
