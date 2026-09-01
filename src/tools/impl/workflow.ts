/**
 * Workflow tool: executes a workflow script that orchestrates multiple
 * subagents deterministically. The engine lives in @/tools/workflow; each
 * agent() call in the script runs as a stateless Letta session spawned via
 * @letta-ai/letta-agent-sdk (loaded lazily — see @/tools/workflow/sdk-loader).
 *
 * Listed in STREAMING_SHELL_TOOLS, so `signal` and `onOutput` are injected
 * into args (not part of the model-facing JSON schema).
 */

import { readFileSync } from "node:fs";
import { loadAgentSdk } from "@/tools/workflow/sdk-loader";
import { SdkSubagentPool } from "@/tools/workflow/sdk-spawner";
import type { WorkflowProgressEvent } from "@/tools/workflow/types";
import { runWorkflow } from "@/tools/workflow/workflow-runner";

interface WorkflowArgs {
  script?: string;
  scriptPath?: string;
  args?: unknown;
  budgetUsd?: number;
  resumeFromRunId?: string;
  backend?: string;
  allowedTools?: string[];
  // Injected by the tool manager; not in the JSON schema.
  signal?: AbortSignal;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

interface WorkflowResult {
  toolReturn: string;
  status: "success" | "error";
}

function formatProgressLine(event: WorkflowProgressEvent): string | null {
  switch (event.kind) {
    case "phase":
      return `── ${event.title} ──`;
    case "log":
      return `» ${event.message}`;
    case "agent": {
      // Only status transitions worth a line; "queued" would be noise.
      if (event.status === "queued") return null;
      const icon =
        event.status === "running"
          ? "▶"
          : event.status === "done"
            ? "✓"
            : event.status === "cached"
              ? "⟳"
              : "✗";
      const suffix = event.detail ? ` — ${event.detail}` : "";
      return `${icon} ${event.label}${suffix}`;
    }
  }
}

export async function workflow(args: WorkflowArgs): Promise<WorkflowResult> {
  let script = typeof args.script === "string" ? args.script : undefined;
  if (typeof args.scriptPath === "string" && args.scriptPath) {
    try {
      script = readFileSync(args.scriptPath, "utf8");
    } catch (error) {
      return {
        toolReturn: `Cannot read scriptPath ${args.scriptPath}: ${String(error)}`,
        status: "error",
      };
    }
  }
  if (!script) {
    return {
      toolReturn: "Provide `script` (inline source) or `scriptPath`.",
      status: "error",
    };
  }

  let sdk: Awaited<ReturnType<typeof loadAgentSdk>>;
  try {
    sdk = await loadAgentSdk();
  } catch (error) {
    return {
      toolReturn: error instanceof Error ? error.message : String(error),
      status: "error",
    };
  }

  const client = sdk.createClient(args.backend ?? "local");
  const pool = new SdkSubagentPool(client, {
    cwd: process.cwd(),
    ...(Array.isArray(args.allowedTools) && args.allowedTools.length > 0
      ? { allowedTools: args.allowedTools }
      : {}),
  });

  try {
    const run = await runWorkflow(pool.spawner, {
      script,
      args: args.args,
      budgetUsd:
        typeof args.budgetUsd === "number" ? args.budgetUsd : undefined,
      resumeFromRunId:
        typeof args.resumeFromRunId === "string" && args.resumeFromRunId
          ? args.resumeFromRunId
          : undefined,
      signal: args.signal,
      onProgress: (event) => {
        const line = formatProgressLine(event);
        if (line) args.onOutput?.(`${line}\n`, "stdout");
      },
    });
    return {
      toolReturn: JSON.stringify(
        {
          runId: run.runId,
          runDir: run.runDir,
          result: run.result,
          agentsSpawned: run.agentsSpawned,
          cacheHits: run.cacheHits,
          totalCostUsd: Number(run.totalCostUsd.toFixed(4)),
        },
        null,
        2,
      ),
      status: "success",
    };
  } catch (error) {
    if (args.signal?.aborted) {
      return { toolReturn: "User interrupted tool execution", status: "error" };
    }
    return {
      toolReturn: `Workflow failed: ${error instanceof Error ? error.message : String(error)}`,
      status: "error",
    };
  } finally {
    await pool.cleanup();
  }
}
