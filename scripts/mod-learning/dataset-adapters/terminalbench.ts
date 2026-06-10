#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DATASET_ADAPTER_SCHEMA_VERSION,
  type DatasetCandidateEvaluation,
  type DatasetTaskEvaluationResult,
  readDatasetAdapterRequest,
} from "../../../src/mods/dataset-adapter.ts";

interface Args {
  action?: string;
  requestPath?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!args.action && arg && !arg.startsWith("--")) {
      args.action = arg;
    } else if (arg === "--request") {
      args.requestPath = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function smokeTasks(taskIds: string[] | undefined): string[] {
  const normalized = (taskIds ?? [])
    .map((taskId) => taskId.trim())
    .filter(Boolean);
  if (normalized.length > 0) return normalized;
  return ["extract-elf"];
}

async function writeTaskArtifacts(params: {
  artifactsDir: string;
  candidatePath: string;
  taskId: string;
}): Promise<DatasetTaskEvaluationResult> {
  const taskDir = path.join(params.artifactsDir, "tasks", params.taskId);
  const rawDir = path.join(taskDir, "raw");
  await mkdir(rawDir, { recursive: true });

  const reportPath = path.join(taskDir, "report.md");
  const rawTracePath = path.join(rawDir, "trajectory.jsonl");
  await writeFile(
    reportPath,
    [
      `# TerminalBench smoke report: ${params.taskId}`,
      "",
      "This is a command/JSON adapter smoke result.",
      "",
      `- Candidate: ${params.candidatePath}`,
      "- This host-filesystem smoke adapter only writes the expected artifact layout; it does not run a sandboxed TerminalBench trial.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    rawTracePath,
    `${JSON.stringify({ event: "adapter_smoke", taskId: params.taskId })}\n`,
    "utf8",
  );

  return {
    artifacts: { taskDir },
    costUsd: 0,
    durationMs: 0,
    passed: false,
    rawTracePath,
    reportPath,
    taskId: params.taskId,
  };
}

async function evaluateCandidate(requestPath: string): Promise<void> {
  const request = await readDatasetAdapterRequest(requestPath);
  if (request.dataset !== "terminalbench") {
    throw new Error(`TerminalBench adapter cannot evaluate ${request.dataset}`);
  }
  if (request.subset && request.subset !== "smoke") {
    throw new Error(
      `Built-in TerminalBench adapter currently supports only the smoke subset; got ${request.subset}`,
    );
  }

  await mkdir(request.artifactsDir, { recursive: true });
  const tasks = await Promise.all(
    smokeTasks(request.taskIds).map((taskId) =>
      writeTaskArtifacts({
        artifactsDir: request.artifactsDir,
        candidatePath: request.candidate.path,
        taskId,
      }),
    ),
  );
  const scorePath = path.join(request.artifactsDir, "score.json");
  const response: DatasetCandidateEvaluation = {
    action: "evaluate_candidate",
    artifactsDir: request.artifactsDir,
    dataset: request.dataset,
    passed: tasks.length > 0 && tasks.every((task) => task.passed),
    reportPath: path.join(request.artifactsDir, "report.md"),
    schemaVersion: DATASET_ADAPTER_SCHEMA_VERSION,
    score: {
      costUsd: 0,
      durationMs: 0,
      passed: 0,
      passRate: 0,
      total: tasks.length,
    },
    subset: request.subset,
    summary:
      "TerminalBench host-filesystem smoke adapter wrote the expected dataset-learning artifact layout. Real sandboxed TerminalBench execution is intentionally out of scope for this adapter.",
    tasks,
  };
  await writeFile(
    scorePath,
    `${JSON.stringify(response.score, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    response.reportPath ?? path.join(request.artifactsDir, "report.md"),
    [
      "# TerminalBench dataset adapter report",
      "",
      response.summary,
      "",
      `- Dataset: ${request.dataset}`,
      `- Subset: ${request.subset ?? "smoke"}`,
      `- Candidate: ${request.candidate.path}`,
      `- Score: ${response.score.passed}/${response.score.total}`,
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(JSON.stringify(response));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.action !== "evaluate_candidate") {
    throw new Error(
      `Usage: terminalbench.ts evaluate_candidate --request <request.json>`,
    );
  }
  if (!args.requestPath) throw new Error("--request is required");
  await evaluateCandidate(args.requestPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
