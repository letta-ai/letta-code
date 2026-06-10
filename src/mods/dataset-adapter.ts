import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DATASET_ADAPTER_SCHEMA_VERSION = 1 as const;

export type DatasetAdapterAction = "evaluate_candidate";

export interface DatasetAdapterCommandConfig {
  args?: string[];
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ModLearningDatasetConfig {
  adapter: DatasetAdapterCommandConfig;
  dataset: string;
  subset?: string;
  taskIds?: string[];
  trials?: number;
}

export interface DatasetCandidateDescriptor {
  fileName: string;
  index: number;
  modDir: string;
  path: string;
}

export interface DatasetAdapterEvaluateRequest {
  action: "evaluate_candidate";
  artifactsDir: string;
  candidate: DatasetCandidateDescriptor;
  dataset: string;
  repoRoot: string;
  runDir: string;
  schemaVersion: typeof DATASET_ADAPTER_SCHEMA_VERSION;
  subset?: string;
  taskIds?: string[];
  trials?: number;
}

export interface DatasetTaskEvaluationResult {
  artifacts?: Record<string, string>;
  costUsd?: number;
  durationMs?: number;
  passed: boolean;
  rawTracePath?: string;
  reportPath?: string;
  score?: number;
  taskId: string;
  trial?: number;
}

export interface DatasetEvaluationScore {
  costUsd?: number;
  durationMs?: number;
  passed: number;
  passRate: number;
  total: number;
}

export interface DatasetCandidateEvaluation {
  action: "evaluate_candidate";
  artifactsDir?: string;
  dataset: string;
  passed: boolean;
  reportPath?: string;
  schemaVersion: typeof DATASET_ADAPTER_SCHEMA_VERSION;
  score: DatasetEvaluationScore;
  subset?: string;
  summary?: string;
  tasks: DatasetTaskEvaluationResult[];
}

export interface DatasetAdapterCommandRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface DatasetAdapterCommandRunResult {
  args: string[];
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export type DatasetAdapterCommandRunner = (
  command: string,
  args: string[],
  options: DatasetAdapterCommandRunOptions,
) => Promise<DatasetAdapterCommandRunResult>;

export interface RunDatasetAdapterCommandParams {
  baseEnv: NodeJS.ProcessEnv;
  config: ModLearningDatasetConfig;
  request: DatasetAdapterEvaluateRequest;
  requestPath: string;
  repoRoot: string;
  runner: DatasetAdapterCommandRunner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeDatasetTaskIds(
  taskIds: string[] | undefined,
): string[] | undefined {
  const normalized = (taskIds ?? [])
    .map((taskId) => taskId.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeTaskResult(
  value: unknown,
  index: number,
): DatasetTaskEvaluationResult {
  if (!isRecord(value)) {
    return { passed: false, taskId: `task-${index + 1}` };
  }
  return {
    artifacts: optionalStringRecord(value.artifacts),
    costUsd: optionalNumber(value.costUsd),
    durationMs: optionalNumber(value.durationMs),
    passed: optionalBoolean(value.passed) ?? false,
    rawTracePath: optionalString(value.rawTracePath),
    reportPath: optionalString(value.reportPath),
    score: optionalNumber(value.score),
    taskId: optionalTrimmedString(value.taskId) ?? `task-${index + 1}`,
    trial: optionalNumber(value.trial),
  };
}

function sumOptionalNumbers(
  values: Array<number | undefined>,
): number | undefined {
  const present = values.filter(
    (value): value is number => value !== undefined,
  );
  if (present.length === 0) return undefined;
  return present.reduce((total, value) => total + value, 0);
}

export function normalizeDatasetAdapterEvaluation(
  value: unknown,
  request: DatasetAdapterEvaluateRequest,
): DatasetCandidateEvaluation {
  const record = isRecord(value) ? value : {};
  const tasks = Array.isArray(record.tasks)
    ? record.tasks.map(normalizeTaskResult)
    : [];
  const rawScore = isRecord(record.score) ? record.score : {};
  const total = optionalNumber(rawScore.total) ?? tasks.length;
  const passed =
    optionalNumber(rawScore.passed) ??
    tasks.filter((task) => task.passed).length;
  const passRate =
    optionalNumber(rawScore.passRate) ?? (total > 0 ? passed / total : 0);
  const costUsd =
    optionalNumber(rawScore.costUsd) ??
    sumOptionalNumbers(tasks.map((task) => task.costUsd));
  const durationMs =
    optionalNumber(rawScore.durationMs) ??
    sumOptionalNumbers(tasks.map((task) => task.durationMs));
  const allTasksPassed = total > 0 && passed === total;

  return {
    action: "evaluate_candidate",
    artifactsDir: optionalString(record.artifactsDir) ?? request.artifactsDir,
    dataset: optionalString(record.dataset) ?? request.dataset,
    passed: optionalBoolean(record.passed) ?? allTasksPassed,
    reportPath: optionalString(record.reportPath),
    schemaVersion: DATASET_ADAPTER_SCHEMA_VERSION,
    score: {
      costUsd,
      durationMs,
      passed,
      passRate,
      total,
    },
    subset: optionalString(record.subset) ?? request.subset,
    summary: optionalString(record.summary),
    tasks,
  };
}

export function renderDatasetScore(score: DatasetEvaluationScore): string {
  const percent = (score.passRate * 100).toFixed(1);
  return `${score.passed}/${score.total} (${percent}%)`;
}

export async function runDatasetAdapterCommand(
  params: RunDatasetAdapterCommandParams,
): Promise<{
  commandResult: DatasetAdapterCommandRunResult;
  response: DatasetCandidateEvaluation;
}> {
  const request = {
    ...params.request,
    taskIds: normalizeDatasetTaskIds(params.request.taskIds),
  };
  await mkdir(path.dirname(params.requestPath), { recursive: true });
  await writeFile(
    params.requestPath,
    `${JSON.stringify(request, null, 2)}\n`,
    "utf8",
  );

  const adapter = params.config.adapter;
  const args = [
    ...(adapter.args ?? []),
    params.request.action,
    "--request",
    params.requestPath,
  ];
  const commandResult = await params.runner(adapter.command, args, {
    cwd: adapter.cwd ?? params.repoRoot,
    env: {
      ...params.baseEnv,
      ...(adapter.env ?? {}),
    },
    timeoutMs: adapter.timeoutMs ?? 60 * 60 * 1000,
  });

  if (commandResult.exitCode !== 0 || commandResult.timedOut) {
    throw new Error(
      `Dataset adapter failed with exit ${commandResult.exitCode ?? "null"}${
        commandResult.timedOut ? " after timeout" : ""
      }: ${commandResult.stderr.trim() || commandResult.stdout.trim()}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(commandResult.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Dataset adapter returned invalid JSON: ${message}`);
  }

  return {
    commandResult,
    response: normalizeDatasetAdapterEvaluation(parsed, request),
  };
}

export async function readDatasetAdapterRequest(
  requestPath: string,
): Promise<DatasetAdapterEvaluateRequest> {
  const request = JSON.parse(
    await readFile(requestPath, "utf8"),
  ) as DatasetAdapterEvaluateRequest;
  return {
    ...request,
    taskIds: normalizeDatasetTaskIds(request.taskIds),
  };
}
