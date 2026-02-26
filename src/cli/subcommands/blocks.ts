import { parseArgs } from "node:util";
import { getClient } from "../../agent/client";

function printUsage(): void {
  console.log(
    `
Usage:
  letta blocks list --agent <id> [--limit <n>]
  letta blocks copy --block-id <id> [--label <new-label>] [--agent <id>] [--override]
  letta blocks attach --block-id <id> [--agent <id>] [--read-only] [--override]

Notes:
  - Output is JSON only.
  - Uses CLI auth; override with LETTA_API_KEY/LETTA_BASE_URL if needed.
  - Default target agent for copy/attach is LETTA_AGENT_ID.
`.trim(),
  );
}

function parseLimit(value: unknown, fallback: number): number {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function getAgentId(agentFromArgs?: string, agentIdFromArgs?: string): string {
  return agentFromArgs || agentIdFromArgs || process.env.LETTA_AGENT_ID || "";
}

const BLOCKS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  agent: { type: "string" },
  "agent-id": { type: "string" },
  limit: { type: "string" },
  "block-id": { type: "string" },
  label: { type: "string" },
  override: { type: "boolean" },
  "read-only": { type: "boolean" },
} as const;

function parseBlocksArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: BLOCKS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

type CopyBlockResult = {
  sourceBlock: Awaited<
    ReturnType<Awaited<ReturnType<typeof getClient>>["blocks"]["retrieve"]>
  >;
  newBlock: Awaited<
    ReturnType<Awaited<ReturnType<typeof getClient>>["blocks"]["create"]>
  >;
  attachResult: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof getClient>>["agents"]["blocks"]["attach"]
    >
  >;
  detachedBlock?: Awaited<
    ReturnType<Awaited<ReturnType<typeof getClient>>["blocks"]["retrieve"]>
  >;
};

type AttachBlockResult = {
  attachResult: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof getClient>>["agents"]["blocks"]["attach"]
    >
  >;
  detachedBlock?: Awaited<
    ReturnType<Awaited<ReturnType<typeof getClient>>["blocks"]["retrieve"]>
  >;
};

async function copyBlock(
  client: Awaited<ReturnType<typeof getClient>>,
  blockId: string,
  options?: {
    labelOverride?: string;
    targetAgentId?: string;
    override?: boolean;
  },
): Promise<CopyBlockResult> {
  const currentAgentId = getAgentId(options?.targetAgentId);
  if (!currentAgentId) {
    throw new Error(
      "Missing agent id. Set LETTA_AGENT_ID or pass --agent/--agent-id.",
    );
  }

  let detachedBlock:
    | Awaited<ReturnType<typeof client.blocks.retrieve>>
    | undefined;

  const sourceBlock = await client.blocks.retrieve(blockId);
  const targetLabel =
    options?.labelOverride || sourceBlock.label || "migrated-block";

  if (options?.override) {
    const currentBlocksResponse =
      await client.agents.blocks.list(currentAgentId);
    const currentBlocks = Array.isArray(currentBlocksResponse)
      ? currentBlocksResponse
      : (currentBlocksResponse as { items?: unknown[] }).items || [];
    const conflictingBlock = currentBlocks.find(
      (b: { label?: string }) => b.label === targetLabel,
    );

    if (conflictingBlock) {
      console.error(
        `Detaching existing block with label "${targetLabel}" (${conflictingBlock.id})...`,
      );
      detachedBlock = conflictingBlock as Awaited<
        ReturnType<typeof client.blocks.retrieve>
      >;
      try {
        await client.agents.blocks.detach(conflictingBlock.id, {
          agent_id: currentAgentId,
        });
      } catch (detachError) {
        throw new Error(
          `Failed to detach existing block "${targetLabel}": ${
            detachError instanceof Error
              ? detachError.message
              : String(detachError)
          }`,
        );
      }
    }
  }

  let newBlock: Awaited<ReturnType<typeof client.blocks.create>>;
  try {
    newBlock = await client.blocks.create({
      label: targetLabel,
      value: sourceBlock.value,
      description: sourceBlock.description || undefined,
      limit: sourceBlock.limit,
    });
  } catch (createError) {
    if (detachedBlock) {
      console.error(
        `Create failed, reattaching original block "${detachedBlock.label}"...`,
      );
      try {
        await client.agents.blocks.attach(detachedBlock.id, {
          agent_id: currentAgentId,
        });
        console.error("Original block reattached successfully.");
      } catch {
        console.error(
          `WARNING: Failed to reattach original block! Block ID: ${detachedBlock.id}`,
        );
      }
    }
    throw createError;
  }

  let attachResult: Awaited<ReturnType<typeof client.agents.blocks.attach>>;
  try {
    attachResult = await client.agents.blocks.attach(newBlock.id, {
      agent_id: currentAgentId,
    });
  } catch (attachError) {
    if (detachedBlock) {
      console.error(
        `Attach failed, reattaching original block "${detachedBlock.label}"...`,
      );
      try {
        await client.agents.blocks.attach(detachedBlock.id, {
          agent_id: currentAgentId,
        });
        console.error("Original block reattached successfully.");
      } catch {
        console.error(
          `WARNING: Failed to reattach original block! Block ID: ${detachedBlock.id}`,
        );
      }
    }
    throw attachError;
  }

  return { sourceBlock, newBlock, attachResult, detachedBlock };
}

async function attachBlock(
  client: Awaited<ReturnType<typeof getClient>>,
  blockId: string,
  options?: { readOnly?: boolean; targetAgentId?: string; override?: boolean },
): Promise<AttachBlockResult> {
  const currentAgentId = getAgentId(options?.targetAgentId);
  if (!currentAgentId) {
    throw new Error(
      "Missing agent id. Set LETTA_AGENT_ID or pass --agent/--agent-id.",
    );
  }

  let detachedBlock:
    | Awaited<ReturnType<typeof client.blocks.retrieve>>
    | undefined;

  if (options?.override) {
    const sourceBlock = await client.blocks.retrieve(blockId);
    const sourceLabel = sourceBlock.label;

    const currentBlocksResponse =
      await client.agents.blocks.list(currentAgentId);
    const currentBlocks = Array.isArray(currentBlocksResponse)
      ? currentBlocksResponse
      : (currentBlocksResponse as { items?: unknown[] }).items || [];
    const conflictingBlock = currentBlocks.find(
      (b: { label?: string }) => b.label === sourceLabel,
    );

    if (conflictingBlock) {
      console.error(
        `Detaching existing block with label "${sourceLabel}" (${conflictingBlock.id})...`,
      );
      detachedBlock = conflictingBlock as Awaited<
        ReturnType<typeof client.blocks.retrieve>
      >;
      try {
        await client.agents.blocks.detach(conflictingBlock.id, {
          agent_id: currentAgentId,
        });
      } catch (detachError) {
        throw new Error(
          `Failed to detach existing block "${sourceLabel}": ${
            detachError instanceof Error
              ? detachError.message
              : String(detachError)
          }`,
        );
      }
    }
  }

  let attachResult: Awaited<ReturnType<typeof client.agents.blocks.attach>>;
  try {
    attachResult = await client.agents.blocks.attach(blockId, {
      agent_id: currentAgentId,
    });
  } catch (attachError) {
    if (detachedBlock) {
      console.error(
        `Attach failed, reattaching original block "${detachedBlock.label}"...`,
      );
      try {
        await client.agents.blocks.attach(detachedBlock.id, {
          agent_id: currentAgentId,
        });
        console.error("Original block reattached successfully.");
      } catch {
        console.error(
          `WARNING: Failed to reattach original block! Block ID: ${detachedBlock.id}`,
        );
      }
    }
    throw attachError;
  }

  if (options?.readOnly) {
    console.warn(
      "Note: read_only flag is set on the block itself, not per-agent. " +
        "Use the block update API to set read_only if needed.",
    );
  }

  return { attachResult, detachedBlock };
}

export async function runBlocksSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseBlocksArgs>;
  try {
    parsed = parseBlocksArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    printUsage();
    return 1;
  }

  const [action] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }

  try {
    const client = await getClient();

    if (action === "list") {
      const agentId = parsed.values.agent || parsed.values["agent-id"] || "";
      if (!agentId || typeof agentId !== "string") {
        console.error("Missing required --agent <id>.");
        return 1;
      }
      const result = await client.agents.blocks.list(agentId, {
        limit: parseLimit(parsed.values.limit, 1000),
      });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    if (action === "copy") {
      const blockId = parsed.values["block-id"];
      if (!blockId || typeof blockId !== "string") {
        console.error("Missing required --block-id <id>.");
        return 1;
      }
      const agentId = getAgentId(
        parsed.values.agent,
        parsed.values["agent-id"],
      );
      const result = await copyBlock(client, blockId, {
        labelOverride:
          typeof parsed.values.label === "string"
            ? parsed.values.label
            : undefined,
        targetAgentId: agentId,
        override: parsed.values.override === true,
      });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    if (action === "attach") {
      const blockId = parsed.values["block-id"];
      if (!blockId || typeof blockId !== "string") {
        console.error("Missing required --block-id <id>.");
        return 1;
      }
      const agentId = getAgentId(
        parsed.values.agent,
        parsed.values["agent-id"],
      );
      const result = await attachBlock(client, blockId, {
        readOnly: parsed.values["read-only"] === true,
        override: parsed.values.override === true,
        targetAgentId: agentId,
      });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.error(`Unknown action: ${action}`);
  printUsage();
  return 1;
}
