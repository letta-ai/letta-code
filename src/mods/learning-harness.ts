import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DATASET_ADAPTER_SCHEMA_VERSION,
  type DatasetCandidateEvaluation,
  type ModLearningDatasetConfig,
  normalizeDatasetTaskIds,
  renderDatasetScore,
  runDatasetAdapterCommand,
} from "@/mods/dataset-adapter";

export type HeadlessLearningOutputFormat = "json" | "stream-json";

export interface ModLearningExample {
  input: string;
  expected?: string;
  notes?: string;
}

export interface ModLearningEvaluationScenarioSpec {
  name?: string;
  forbiddenTraceMarkers?: string[];
  prompt?: string;
  outputFormat?: HeadlessLearningOutputFormat;
  timeoutMs?: number;
  maxTurns?: number;
  memoryFiles?: Record<string, string>;
  requiredResultMarkers?: string[];
  requiredTraceMarkers?: string[];
  forbiddenResultMarkers?: string[];
}

export interface ModLearningEvaluationSpec
  extends ModLearningEvaluationScenarioSpec {
  scenarios?: ModLearningEvaluationScenarioSpec[];
}

export interface ModLearningSpec {
  name: string;
  slug?: string;
  objective: string;
  targetModName?: string;
  requirements: string[];
  candidateDiversityHints?: string[];
  modApiHints?: string[];
  examples?: ModLearningExample[];
  evaluation: ModLearningEvaluationSpec;
}

export interface CommandRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface CommandRunResult {
  args: string[];
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandRunOptions,
) => Promise<CommandRunResult>;

export interface MarkerCheck {
  marker: string;
  present: boolean;
}

export interface ModLearningEvaluationResult {
  forbiddenResultMarkers: MarkerCheck[];
  forbiddenTraceMarkers: MarkerCheck[];
  requiredResultMarkers: MarkerCheck[];
  requiredTraceMarkers: MarkerCheck[];
  resultText: string;
  passed: boolean;
  scenarioResults?: ModLearningScenarioEvaluationResult[];
}

export interface ModLearningScenarioEvaluationResult {
  evalExit: number | null;
  evalMemoryDir: string;
  forbiddenResultMarkers: MarkerCheck[];
  forbiddenTraceMarkers: MarkerCheck[];
  name: string;
  requiredResultMarkers: MarkerCheck[];
  requiredTraceMarkers: MarkerCheck[];
  resultText: string;
  timedOut: boolean;
  passed: boolean;
}

export interface RunModLearningOptions {
  backend?: string;
  candidateCount?: number;
  candidateFileName?: string;
  candidateSourcePath?: string;
  cliArgsPrefix?: string[];
  cliCommand?: string;
  commandRunner?: CommandRunner;
  dataset?: ModLearningDatasetConfig;
  env?: NodeJS.ProcessEnv;
  evalModel?: string;
  generationModel?: string;
  onProgress?: (progress: ModLearningProgress) => void;
  outputBaseDir?: string;
  promoteToPath?: string;
  repoRoot: string;
  runDir?: string;
  skipGeneration?: boolean;
  spec: ModLearningSpec;
}

export type ModLearningProgressPhase =
  | "preparing"
  | "generating"
  | "evaluating"
  | "promoting"
  | "writing-report"
  | "done";

export interface ModLearningProgress {
  candidateIndex?: number;
  candidatePath: string;
  candidateRunDir?: string;
  candidateCount?: number;
  message: string;
  phase: ModLearningProgressPhase;
  runDir: string;
}

export interface ModLearningAttemptSummary {
  candidateIndex: number;
  candidatePath: string;
  datasetCostUsd?: number;
  datasetDurationMs?: number;
  datasetPassedTasks?: number;
  datasetPassRate?: number;
  datasetTotalTasks?: number;
  evalExit: number | null | "not run";
  generationExit: number | null | "skipped";
  missingRequiredResultMarkers: string[];
  missingRequiredTraceMarkers: string[];
  passed: boolean;
  presentForbiddenResultMarkers: string[];
  presentForbiddenTraceMarkers: string[];
  reportPath: string;
  runDir: string;
  score: number;
}

export interface ModLearningReport {
  attempts?: ModLearningAttemptSummary[];
  candidateCount?: number;
  candidateIndex?: number;
  candidatePath: string;
  datasetEvaluation?: DatasetCandidateEvaluation;
  evaluatorKind?: ModLearningEvaluatorKind;
  evalMemoryDir: string;
  evalResult: CommandRunResult | null;
  evaluation: ModLearningEvaluationResult;
  generationResult: CommandRunResult | null;
  passed: boolean;
  promotedToPath: string | null;
  reportPath: string;
  runDir: string;
  score?: number;
  selectionScore?: ModLearningCandidateSelectionScore;
  selectedCandidateIndex?: number;
  spec: ModLearningSpec;
}

export type ModLearningEvaluatorKind = "scenario-suite" | "dataset-adapter";

export interface ModLearningCandidateSelectionScore {
  costUsd?: number;
  durationMs?: number;
  kind: ModLearningEvaluatorKind;
  markerScore?: number;
  passed: boolean;
  passedTasks?: number;
  passRate?: number;
  primary: number;
  totalTasks?: number;
}

interface ModLearningCandidateDescriptor {
  dir: string;
  fileName: string;
  index: number;
  path: string;
}

interface ModLearningEvaluatorContext {
  backend?: string;
  baseEnv: NodeJS.ProcessEnv;
  candidate: ModLearningCandidateDescriptor;
  cliArgsPrefix: string[];
  cliCommand: string;
  evalModel?: string;
  repoRoot: string;
  runDir: string;
  runner: CommandRunner;
}

interface ModLearningEvaluatorResult {
  artifactsDir: string;
  commandResult: CommandRunResult | null;
  datasetEvaluation?: DatasetCandidateEvaluation;
  evaluation: ModLearningEvaluationResult;
  score: number;
  selectionScore: ModLearningCandidateSelectionScore;
}

interface ModLearningEvaluator {
  artifactsDir: string;
  evaluate: (
    context: ModLearningEvaluatorContext,
  ) => Promise<ModLearningEvaluatorResult>;
  kind: ModLearningEvaluatorKind;
  label: string;
}

export interface ModLearningPromptHistory {
  candidateCount?: number;
  candidateIndex?: number;
  historyPath?: string;
  previousAttemptDirs?: string[];
}

interface HeadlessCommandOptions {
  backend?: string;
  maxTurns?: number;
  model?: string;
  noMods?: boolean;
  outputFormat: HeadlessLearningOutputFormat;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "mod-learning-run";
}

function timestampForPath(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function defaultModLearningRunDirectory(
  spec: ModLearningSpec,
  baseDir: string = path.join(".letta", "mod-learning-runs"),
  now: Date = new Date(),
): string {
  return path.join(
    baseDir,
    `${slugify(spec.slug ?? spec.name)}-${timestampForPath(now)}`,
  );
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function markerChecks(
  markers: string[] | undefined,
  haystack: string,
): MarkerCheck[] {
  return (markers ?? []).map((marker) => ({
    marker,
    present: haystack.includes(marker),
  }));
}

function allPresent(checks: MarkerCheck[]): boolean {
  return checks.every((check) => check.present);
}

function allAbsent(checks: MarkerCheck[]): boolean {
  return checks.every((check) => !check.present);
}

function combineMarkers(
  base: string[] | undefined,
  override: string[] | undefined,
): string[] | undefined {
  const combined = [...(base ?? []), ...(override ?? [])];
  return combined.length > 0 ? combined : undefined;
}

function scenarioName(
  index: number,
  scenario: ModLearningEvaluationScenarioSpec,
): string {
  return scenario.name?.trim() || `scenario-${index + 1}`;
}

function evaluationScenarios(
  evaluation: ModLearningEvaluationSpec,
): Array<{ name: string; spec: ModLearningEvaluationScenarioSpec }> {
  const scenarios = evaluation.scenarios;
  if (!scenarios || scenarios.length === 0) {
    if (!evaluation.prompt?.trim()) {
      throw new Error(
        "evaluation.prompt is required when no scenarios are configured",
      );
    }
    return [{ name: "default", spec: evaluation }];
  }

  return scenarios.map((scenario, index) => {
    const prompt = scenario.prompt ?? evaluation.prompt;
    if (!prompt?.trim()) {
      throw new Error(`evaluation.scenarios[${index}].prompt is required`);
    }
    return {
      name: scenarioName(index, scenario),
      spec: {
        forbiddenResultMarkers: combineMarkers(
          evaluation.forbiddenResultMarkers,
          scenario.forbiddenResultMarkers,
        ),
        forbiddenTraceMarkers: combineMarkers(
          evaluation.forbiddenTraceMarkers,
          scenario.forbiddenTraceMarkers,
        ),
        maxTurns: scenario.maxTurns ?? evaluation.maxTurns,
        memoryFiles: {
          ...(evaluation.memoryFiles ?? {}),
          ...(scenario.memoryFiles ?? {}),
        },
        outputFormat: scenario.outputFormat ?? evaluation.outputFormat,
        prompt,
        requiredResultMarkers: combineMarkers(
          evaluation.requiredResultMarkers,
          scenario.requiredResultMarkers,
        ),
        requiredTraceMarkers: combineMarkers(
          evaluation.requiredTraceMarkers,
          scenario.requiredTraceMarkers,
        ),
        timeoutMs: scenario.timeoutMs ?? evaluation.timeoutMs,
      },
    };
  });
}

function prefixMarkerChecks(
  name: string,
  checks: MarkerCheck[],
): MarkerCheck[] {
  return checks.map((check) => ({
    marker: `${name}: ${check.marker}`,
    present: check.present,
  }));
}

function normalizeCandidateFileName(
  spec: ModLearningSpec,
  fileName: string | undefined,
): string {
  if (fileName?.trim()) return fileName;
  return `${slugify(spec.slug ?? spec.name)}.ts`;
}

function safeJoin(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return resolved;
  }
  throw new Error(`Path escapes run directory: ${relativePath}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonArtifact(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeCommandArtifacts(
  prefix: string,
  command: string,
  args: string[],
  result: CommandRunResult,
): Promise<void> {
  await writeFile(
    `${prefix}.command.txt`,
    `${renderCommand(command, args)}\n`,
    "utf8",
  );
  await writeFile(`${prefix}.stdout`, result.stdout, "utf8");
  await writeFile(`${prefix}.stderr`, result.stderr, "utf8");
  await writeJsonArtifact(`${prefix}.result.json`, result);
}

async function prepareMemoryFiles(
  memoryDir: string,
  memoryFiles: Record<string, string> | undefined,
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(memoryFiles ?? {})) {
    const filePath = safeJoin(memoryDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

function renderEvaluationPrompt(prompt: string, memoryDir: string): string {
  return prompt.replace(/\$\{MEMORY_DIR\}|\$MEMORY_DIR/g, () => memoryDir);
}

function renderEvaluationSummaryForPrompt(spec: ModLearningSpec): string {
  const scenarios = evaluationScenarios(spec.evaluation);
  if (scenarios.length === 1) {
    return scenarios[0]?.spec.prompt ?? "";
  }
  return scenarios
    .map(({ name, spec: scenario }, index) => {
      const requiredResultMarkers = scenario.requiredResultMarkers?.length
        ? `\nRequired result markers: ${scenario.requiredResultMarkers.join(", ")}`
        : "";
      const forbiddenResultMarkers = scenario.forbiddenResultMarkers?.length
        ? `\nForbidden result markers: ${scenario.forbiddenResultMarkers.join(", ")}`
        : "";
      return `Scenario ${index + 1} (${name}):\nPrompt: ${scenario.prompt}${requiredResultMarkers}${forbiddenResultMarkers}`;
    })
    .join("\n\n");
}

export function buildModLearningPrompt(
  spec: ModLearningSpec,
  candidatePath: string,
  history?: ModLearningPromptHistory,
): string {
  const requirements = spec.requirements
    .map((requirement, index) => `${index + 1}. ${requirement}`)
    .join("\n");
  const hints = (spec.modApiHints ?? [])
    .map((hint, index) => `${index + 1}. ${hint}`)
    .join("\n");
  const examples = (spec.examples ?? [])
    .map((example, index) => {
      const parts = [`Example ${index + 1}:`, `Input: ${example.input}`];
      if (hasText(example.expected))
        parts.push(`Expected: ${example.expected}`);
      if (hasText(example.notes)) parts.push(`Notes: ${example.notes}`);
      return parts.join("\n");
    })
    .join("\n\n");
  const previousAttemptDirs = history?.previousAttemptDirs ?? [];
  const candidateCount = history?.candidateCount ?? 1;
  const candidateIndex = history?.candidateIndex ?? 1;
  const attemptLabel =
    candidateCount > 1
      ? `\nCandidate attempt: ${candidateIndex} of ${candidateCount}`
      : "";
  const diversityHints = spec.candidateDiversityHints ?? [];
  const assignedDiversityHint =
    candidateCount > 1 && diversityHints.length > 0
      ? diversityHints[(candidateIndex - 1) % diversityHints.length]
      : undefined;
  const diversitySection =
    candidateCount > 1
      ? `\nCandidate diversity:\n- This run compares multiple harness proposals. Do not merely clone a prior passing implementation.\n- Pick a concrete implementation strategy and include a short top-level comment in the candidate file starting with \`// Proposal:\` that names the strategy.\n- Optimize for passing every scenario, including negative controls, not just the first happy path.${assignedDiversityHint ? `\n- Proposal focus for this candidate: ${assignedDiversityHint}` : ""}\n`
      : "";
  const historySection =
    previousAttemptDirs.length > 0
      ? `\nPrior candidate feedback is available on disk. Before writing this candidate, inspect the previous report(s), candidate source, stdout/stderr, and eval artifacts to avoid repeating failures. Treat these files as read-only.\n${history?.historyPath ? `\nPrior attempt summary file: ${history.historyPath}\n` : ""}\nPrior attempt directories:\n${previousAttemptDirs
          .map((attemptDir, index) => `${index + 1}. ${attemptDir}`)
          .join("\n")}\n`
      : "";
  const evaluationSummary = renderEvaluationSummaryForPrompt(spec);

  return `You are dogfooding Letta Code's trusted local mod system. Learn a minimal mod from the target env and write the candidate mod file.\n\nTarget: ${spec.name}${attemptLabel}\nObjective: ${spec.objective}\nCandidate file, absolute path: ${candidatePath}\n\nHard rules:\n- Edit only the candidate file above. Do not modify repository source, docs, package files, tests, or git state.\n- Export either \`activate(letta)\` or a default function.\n- Use the trusted local mod API directly; do not import from "@/..." or from this repo's src files.\n- Prefer a small implementation that satisfies the behavior over a polished product mod.\n- If you register an eval-facing tool, set \`requiresApproval: false\` and keep it read-only.\n- Do not run tests or lint. Write the candidate file and stop.\n${diversitySection}${historySection}\nMinimal mod API reminder:\n\`\`\`ts\nexport function activate(letta) {\n  const disposers = [];\n  if (letta.capabilities.events.turns) {\n    disposers.push(letta.events.on("turn_start", (event) => {\n      // event.input is an array of message/approval objects. Do not append\n      // strings to existing content because content may be structured parts.\n      event.input = [\n        ...event.input,\n        { type: "message", role: "system", content: "mod reminder" },\n      ];\n      return { input: event.input };\n    }));\n  }\n  if (letta.capabilities.events.tools) {\n    disposers.push(letta.events.on("tool_start", (event, ctx) => {\n      // event.toolName, event.args, event.conversationId, ctx.getContext().\n    }));\n  }\n  if (letta.capabilities.tools) {\n    disposers.push(letta.tools.register({\n      name: "example_tool",\n      description: "Short tool description",\n      parameters: { type: "object", properties: {}, additionalProperties: false },\n      requiresApproval: false,\n      parallelSafe: true,\n      run(ctx) {\n        // For conversation-scoped state, use ctx.conversation.id or\n        // ctx.getContext().sessionId as the key.\n        return "ok";\n      },\n    }));\n  }\n  return () => disposers.reverse().forEach((dispose) => dispose());\n}\n\`\`\`\n\nRequirements:\n${requirements}\n${hints ? `\nUseful API/implementation hints:\n${hints}\n` : ""}${examples ? `\nDemos:\n${examples}\n` : ""}\nEvaluation scenario(s) this candidate must satisfy:\n${evaluationSummary}\n\nWrite the candidate mod now, then reply with only a concise summary and the file path.`;
}
function buildHeadlessArgs(
  prompt: string,
  options: HeadlessCommandOptions,
): string[] {
  const args = [
    "-p",
    prompt,
    "--new-agent",
    "--no-memfs",
    "--no-system-info-reminder",
    "--yolo",
    "--output-format",
    options.outputFormat,
  ];
  if (options.noMods) args.push("--no-mods");
  if (options.model) args.push("--model", options.model);
  if (options.backend) args.push("--backend", options.backend);
  if (options.maxTurns !== undefined)
    args.push("--max-turns", String(options.maxTurns));
  return args;
}

export function extractHeadlessResultText(
  stdout: string,
  outputFormat: HeadlessLearningOutputFormat,
): string {
  if (outputFormat === "json") {
    try {
      const parsed = JSON.parse(stdout) as { result?: unknown };
      return typeof parsed.result === "string" ? parsed.result : "";
    } catch {
      return "";
    }
  }

  const assistantParts: string[] = [];
  let finalResult: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const payload =
        parsed.type === "stream_event" &&
        parsed.event &&
        typeof parsed.event === "object"
          ? (parsed.event as Record<string, unknown>)
          : parsed;
      if (payload.type === "result" && typeof payload.result === "string") {
        finalResult = payload.result;
      } else if (
        (payload.type === "message" || payload.type === undefined) &&
        payload.message_type === "assistant_message" &&
        typeof payload.content === "string"
      ) {
        assistantParts.push(payload.content);
      }
    } catch {
      // Ignore non-JSON diagnostic lines; raw stdout is still saved as trace.
    }
  }
  return finalResult ?? assistantParts.join("");
}

export function evaluateModLearningRun(params: {
  exitCode: number | null;
  outputFormat: HeadlessLearningOutputFormat;
  spec: ModLearningEvaluationScenarioSpec;
  stderr?: string;
  stdout: string;
  timedOut: boolean;
}): ModLearningEvaluationResult {
  const resultText = extractHeadlessResultText(
    params.stdout,
    params.outputFormat,
  );
  const requiredResultMarkers = markerChecks(
    params.spec.requiredResultMarkers,
    resultText,
  );
  const traceText = `${params.stdout}\n${params.stderr ?? ""}`;
  const requiredTraceMarkers = markerChecks(
    params.spec.requiredTraceMarkers,
    traceText,
  );
  const forbiddenTraceMarkers = markerChecks(
    params.spec.forbiddenTraceMarkers,
    traceText,
  );
  const forbiddenResultMarkers = markerChecks(
    params.spec.forbiddenResultMarkers,
    resultText,
  );
  const passed =
    params.exitCode === 0 &&
    !params.timedOut &&
    allPresent(requiredResultMarkers) &&
    allPresent(requiredTraceMarkers) &&
    allAbsent(forbiddenResultMarkers) &&
    allAbsent(forbiddenTraceMarkers);

  return {
    forbiddenResultMarkers,
    forbiddenTraceMarkers,
    requiredResultMarkers,
    requiredTraceMarkers,
    resultText,
    passed,
  };
}

function aggregateScenarioEvaluations(
  scenarioResults: ModLearningScenarioEvaluationResult[],
): ModLearningEvaluationResult {
  return {
    forbiddenResultMarkers: scenarioResults.flatMap((scenario) =>
      prefixMarkerChecks(scenario.name, scenario.forbiddenResultMarkers),
    ),
    forbiddenTraceMarkers: scenarioResults.flatMap((scenario) =>
      prefixMarkerChecks(scenario.name, scenario.forbiddenTraceMarkers),
    ),
    passed: scenarioResults.every((scenario) => scenario.passed),
    requiredResultMarkers: scenarioResults.flatMap((scenario) =>
      prefixMarkerChecks(scenario.name, scenario.requiredResultMarkers),
    ),
    requiredTraceMarkers: scenarioResults.flatMap((scenario) =>
      prefixMarkerChecks(scenario.name, scenario.requiredTraceMarkers),
    ),
    resultText: scenarioResults
      .map((scenario) => `## ${scenario.name}\n${scenario.resultText}`)
      .join("\n\n"),
    scenarioResults,
  };
}

function markerScore(evaluation: ModLearningEvaluationResult): number {
  return [
    ...evaluation.requiredResultMarkers.map((check) => check.present),
    ...evaluation.requiredTraceMarkers.map((check) => check.present),
    ...evaluation.forbiddenResultMarkers.map((check) => !check.present),
    ...evaluation.forbiddenTraceMarkers.map((check) => !check.present),
  ].filter(Boolean).length;
}

function markerSelectionScore(
  evaluation: ModLearningEvaluationResult,
): ModLearningCandidateSelectionScore {
  const score = markerScore(evaluation);
  return {
    kind: "scenario-suite",
    markerScore: score,
    passed: evaluation.passed,
    primary: score,
  };
}

function datasetSelectionScore(
  evaluation: DatasetCandidateEvaluation,
): ModLearningCandidateSelectionScore {
  return {
    costUsd: evaluation.score.costUsd,
    durationMs: evaluation.score.durationMs,
    kind: "dataset-adapter",
    passed: evaluation.passed,
    passedTasks: evaluation.score.passed,
    passRate: evaluation.score.passRate,
    primary: evaluation.score.passRate,
    totalTasks: evaluation.score.total,
  };
}

function datasetEvaluationToResult(
  evaluation: DatasetCandidateEvaluation,
): ModLearningEvaluationResult {
  const resultText = [
    `Dataset: ${evaluation.dataset}${evaluation.subset ? `/${evaluation.subset}` : ""}`,
    `Pass rate: ${renderDatasetScore(evaluation.score)}`,
    ...(evaluation.score.costUsd !== undefined
      ? [`Cost: $${evaluation.score.costUsd.toFixed(4)}`]
      : []),
    ...(evaluation.score.durationMs !== undefined
      ? [`Duration: ${evaluation.score.durationMs}ms`]
      : []),
    ...(evaluation.summary ? ["", evaluation.summary] : []),
  ].join("\n");
  return {
    forbiddenResultMarkers: [],
    forbiddenTraceMarkers: [],
    passed: evaluation.passed,
    requiredResultMarkers: [],
    requiredTraceMarkers: [],
    resultText,
  };
}

function selectionScoreFromReport(
  report: ModLearningReport,
): ModLearningCandidateSelectionScore {
  if (report.selectionScore) return report.selectionScore;
  if (report.datasetEvaluation)
    return datasetSelectionScore(report.datasetEvaluation);
  return markerSelectionScore(report.evaluation);
}

function compareDatasetReports(
  candidate: ModLearningReport,
  incumbent: ModLearningReport,
): number {
  const candidateScore = selectionScoreFromReport(candidate);
  const incumbentScore = selectionScoreFromReport(incumbent);
  const passRateDelta = candidateScore.primary - incumbentScore.primary;
  if (passRateDelta !== 0) return passRateDelta;

  const candidateCost = candidateScore.costUsd ?? Number.POSITIVE_INFINITY;
  const incumbentCost = incumbentScore.costUsd ?? Number.POSITIVE_INFINITY;
  if (candidateCost !== incumbentCost) return incumbentCost - candidateCost;

  const candidateDuration =
    candidateScore.durationMs ?? Number.POSITIVE_INFINITY;
  const incumbentDuration =
    incumbentScore.durationMs ?? Number.POSITIVE_INFINITY;
  if (candidateDuration !== incumbentDuration) {
    return incumbentDuration - candidateDuration;
  }

  return (incumbent.candidateIndex ?? 0) - (candidate.candidateIndex ?? 0);
}

function compareScenarioReports(
  candidate: ModLearningReport,
  incumbent: ModLearningReport,
): number {
  if (candidate.passed !== incumbent.passed) {
    return candidate.passed ? 1 : -1;
  }
  if (candidate.passed && incumbent.passed) {
    return (incumbent.candidateIndex ?? 0) - (candidate.candidateIndex ?? 0);
  }

  const candidateScore = selectionScoreFromReport(candidate).primary;
  const incumbentScore = selectionScoreFromReport(incumbent).primary;
  if (candidateScore !== incumbentScore) return candidateScore - incumbentScore;

  return (candidate.candidateIndex ?? 0) - (incumbent.candidateIndex ?? 0);
}

function compareReportsForSelection(
  candidate: ModLearningReport,
  incumbent: ModLearningReport,
): number {
  const candidateKind = selectionScoreFromReport(candidate).kind;
  const incumbentKind = selectionScoreFromReport(incumbent).kind;
  if (
    candidateKind === "dataset-adapter" ||
    incumbentKind === "dataset-adapter"
  ) {
    return compareDatasetReports(candidate, incumbent);
  }
  return compareScenarioReports(candidate, incumbent);
}

function missingMarkers(checks: MarkerCheck[]): string[] {
  return checks.filter((check) => !check.present).map((check) => check.marker);
}

function presentMarkers(checks: MarkerCheck[]): string[] {
  return checks.filter((check) => check.present).map((check) => check.marker);
}

function summarizeAttempt(
  report: ModLearningReport,
): ModLearningAttemptSummary {
  return {
    candidateIndex: report.candidateIndex ?? 1,
    candidatePath: report.candidatePath,
    datasetCostUsd: report.datasetEvaluation?.score.costUsd,
    datasetDurationMs: report.datasetEvaluation?.score.durationMs,
    datasetPassedTasks: report.datasetEvaluation?.score.passed,
    datasetPassRate: report.datasetEvaluation?.score.passRate,
    datasetTotalTasks: report.datasetEvaluation?.score.total,
    evalExit: report.evalResult?.exitCode ?? "not run",
    generationExit: report.generationResult?.exitCode ?? "skipped",
    missingRequiredResultMarkers: missingMarkers(
      report.evaluation.requiredResultMarkers,
    ),
    missingRequiredTraceMarkers: missingMarkers(
      report.evaluation.requiredTraceMarkers,
    ),
    passed: report.passed,
    presentForbiddenResultMarkers: presentMarkers(
      report.evaluation.forbiddenResultMarkers,
    ),
    presentForbiddenTraceMarkers: presentMarkers(
      report.evaluation.forbiddenTraceMarkers,
    ),
    reportPath: report.reportPath,
    runDir: report.runDir,
    score: report.score ?? markerScore(report.evaluation),
  };
}

function candidateDirectoryName(candidateIndex: number): string {
  return String(candidateIndex).padStart(3, "0");
}

function normalizeCandidateCount(candidateCount: number | undefined): number {
  if (candidateCount === undefined) return 1;
  if (!Number.isInteger(candidateCount) || candidateCount < 1) {
    throw new Error("candidateCount must be a positive integer");
  }
  return candidateCount;
}

function selectBestReport(reports: ModLearningReport[]): ModLearningReport {
  if (reports.length === 0) {
    throw new Error("No mod learning candidates were evaluated");
  }
  return reports.reduce((best, report) =>
    compareReportsForSelection(report, best) > 0 ? report : best,
  );
}

function renderHistoryIndex(params: {
  attempts: ModLearningAttemptSummary[];
  selectedCandidateIndex?: number;
  spec: ModLearningSpec;
}): string {
  const lines = [
    `# Mod learning history: ${params.spec.name}`,
    "",
    `- Attempts: ${params.attempts.length}`,
    `- Selected candidate: ${params.selectedCandidateIndex ?? "not selected yet"}`,
    "",
  ];

  for (const attempt of params.attempts) {
    lines.push(
      `## Candidate ${attempt.candidateIndex}: ${attempt.passed ? "PASS" : "FAIL"}`,
      "",
      `- Score: ${attempt.score}`,
      `- Directory: ${attempt.runDir}`,
      `- Candidate: ${attempt.candidatePath}`,
      `- Report: ${attempt.reportPath}`,
      `- Generation exit: ${attempt.generationExit}`,
      `- Eval exit: ${attempt.evalExit}`,
    );
    if (attempt.datasetPassRate !== undefined) {
      lines.push(
        `- Dataset pass rate: ${attempt.datasetPassedTasks ?? 0}/${attempt.datasetTotalTasks ?? 0} (${(attempt.datasetPassRate * 100).toFixed(1)}%)`,
      );
    }
    if (attempt.datasetCostUsd !== undefined) {
      lines.push(`- Dataset cost: $${attempt.datasetCostUsd.toFixed(4)}`);
    }
    if (attempt.datasetDurationMs !== undefined) {
      lines.push(`- Dataset duration: ${attempt.datasetDurationMs}ms`);
    }
    if (attempt.missingRequiredResultMarkers.length > 0) {
      lines.push(
        `- Missing required result markers: ${attempt.missingRequiredResultMarkers.join(", ")}`,
      );
    }
    if (attempt.missingRequiredTraceMarkers.length > 0) {
      lines.push(
        `- Missing required trace markers: ${attempt.missingRequiredTraceMarkers.join(", ")}`,
      );
    }
    if (attempt.presentForbiddenResultMarkers.length > 0) {
      lines.push(
        `- Present forbidden result markers: ${attempt.presentForbiddenResultMarkers.join(", ")}`,
      );
    }
    if (attempt.presentForbiddenTraceMarkers.length > 0) {
      lines.push(
        `- Present forbidden trace markers: ${attempt.presentForbiddenTraceMarkers.join(", ")}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function writeHistoryIndex(params: {
  attempts: ModLearningAttemptSummary[];
  historyPath: string;
  selectedCandidateIndex?: number;
  spec: ModLearningSpec;
}): Promise<void> {
  await writeFile(
    params.historyPath,
    renderHistoryIndex({
      attempts: params.attempts,
      selectedCandidateIndex: params.selectedCandidateIndex,
      spec: params.spec,
    }),
    "utf8",
  );
}

export async function defaultCommandRunner(
  command: string,
  args: string[],
  options: CommandRunOptions,
): Promise<CommandRunResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let killedHard = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && !killedHard) {
          killedHard = true;
          child.kill("SIGKILL");
        }
      }, 5000).unref();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      stderrChunks.push(Buffer.from(String(error.stack ?? error.message)));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        args,
        command,
        cwd: options.cwd,
        durationMs: Date.now() - startedAt,
        exitCode,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        timedOut,
      });
    });
  });
}

function createScenarioSuiteEvaluator(params: {
  runDir: string;
  spec: ModLearningSpec;
}): ModLearningEvaluator {
  const hasConfiguredScenarios =
    (params.spec.evaluation.scenarios?.length ?? 0) > 0;
  const artifactsDir = hasConfiguredScenarios
    ? path.join(params.runDir, "eval")
    : path.join(params.runDir, "eval-memory");
  const scenarios = evaluationScenarios(params.spec.evaluation);

  return {
    artifactsDir,
    async evaluate(context) {
      let commandResult: CommandRunResult | null = null;
      const scenarioResults: ModLearningScenarioEvaluationResult[] = [];

      for (const [scenarioIndex, scenario] of scenarios.entries()) {
        const scenarioSpec = scenario.spec;
        const scenarioDir = hasConfiguredScenarios
          ? path.join(
              context.runDir,
              "eval",
              `${candidateDirectoryName(scenarioIndex + 1)}-${slugify(scenario.name)}`,
            )
          : context.runDir;
        const scenarioMemoryDir = hasConfiguredScenarios
          ? path.join(scenarioDir, "memory")
          : artifactsDir;
        await prepareMemoryFiles(scenarioMemoryDir, scenarioSpec.memoryFiles);

        const outputFormat = scenarioSpec.outputFormat ?? "stream-json";
        const evalPrompt = renderEvaluationPrompt(
          scenarioSpec.prompt ?? "",
          scenarioMemoryDir,
        );
        const evalArgs = [
          ...context.cliArgsPrefix,
          ...buildHeadlessArgs(evalPrompt, {
            backend: context.backend,
            maxTurns: scenarioSpec.maxTurns ?? 8,
            model: context.evalModel,
            outputFormat,
          }),
        ];
        await writeFile(
          hasConfiguredScenarios
            ? path.join(scenarioDir, "prompt.md")
            : path.join(context.runDir, "eval-prompt.md"),
          evalPrompt,
          "utf8",
        );
        const scenarioEvalResult = await context.runner(
          context.cliCommand,
          evalArgs,
          {
            cwd: context.repoRoot,
            env: {
              ...context.baseEnv,
              LETTA_EXTENSIONS_DIR: context.candidate.dir,
              LETTA_MODS_DIR: context.candidate.dir,
              MEMORY_DIR: scenarioMemoryDir,
            },
            timeoutMs: scenarioSpec.timeoutMs ?? 15 * 60 * 1000,
          },
        );
        commandResult ??= scenarioEvalResult;
        await writeCommandArtifacts(
          hasConfiguredScenarios
            ? path.join(scenarioDir, "eval")
            : path.join(context.runDir, "eval"),
          context.cliCommand,
          evalArgs,
          scenarioEvalResult,
        );
        const scenarioEvaluation = evaluateModLearningRun({
          exitCode: scenarioEvalResult.exitCode,
          outputFormat,
          spec: scenarioSpec,
          stderr: scenarioEvalResult.stderr,
          stdout: scenarioEvalResult.stdout,
          timedOut: scenarioEvalResult.timedOut,
        });
        scenarioResults.push({
          ...scenarioEvaluation,
          evalExit: scenarioEvalResult.exitCode,
          evalMemoryDir: scenarioMemoryDir,
          name: scenario.name,
          timedOut: scenarioEvalResult.timedOut,
        });
      }

      const evaluation = hasConfiguredScenarios
        ? aggregateScenarioEvaluations(scenarioResults)
        : (scenarioResults[0] ?? {
            forbiddenResultMarkers: [],
            forbiddenTraceMarkers: [],
            passed: false,
            requiredResultMarkers: [],
            requiredTraceMarkers: [],
            resultText: "",
          });
      const selectionScore = markerSelectionScore(evaluation);
      return {
        artifactsDir,
        commandResult,
        evaluation,
        score: selectionScore.primary,
        selectionScore,
      };
    },
    kind: "scenario-suite",
    label: hasConfiguredScenarios ? "scenario suite" : "scenario",
  };
}

function createDatasetAdapterEvaluator(params: {
  dataset: ModLearningDatasetConfig;
  runDir: string;
}): ModLearningEvaluator {
  const artifactsDir = path.join(params.runDir, "dataset");
  const label = params.dataset.subset
    ? `${params.dataset.dataset}/${params.dataset.subset}`
    : params.dataset.dataset;

  return {
    artifactsDir,
    async evaluate(context) {
      await mkdir(artifactsDir, { recursive: true });
      const request = {
        action: "evaluate_candidate" as const,
        artifactsDir,
        candidate: {
          fileName: context.candidate.fileName,
          index: context.candidate.index,
          modDir: context.candidate.dir,
          path: context.candidate.path,
        },
        dataset: params.dataset.dataset,
        repoRoot: context.repoRoot,
        runDir: context.runDir,
        schemaVersion: DATASET_ADAPTER_SCHEMA_VERSION,
        subset: params.dataset.subset,
        taskIds: normalizeDatasetTaskIds(params.dataset.taskIds),
        trials: params.dataset.trials,
      };
      const requestPath = path.join(artifactsDir, "adapter-request.json");
      const datasetResult = await runDatasetAdapterCommand({
        baseEnv: {
          ...context.baseEnv,
          LETTA_EXTENSIONS_DIR: context.candidate.dir,
          LETTA_MODS_DIR: context.candidate.dir,
        },
        config: params.dataset,
        repoRoot: context.repoRoot,
        request,
        requestPath,
        runner: context.runner,
      });
      await writeCommandArtifacts(
        path.join(artifactsDir, "adapter"),
        params.dataset.adapter.command,
        [
          ...(params.dataset.adapter.args ?? []),
          "evaluate_candidate",
          "--request",
          requestPath,
        ],
        datasetResult.commandResult,
      );
      await writeJsonArtifact(
        path.join(artifactsDir, "adapter-response.json"),
        datasetResult.response,
      );
      await writeJsonArtifact(
        path.join(artifactsDir, "score.json"),
        datasetResult.response.score,
      );

      const selectionScore = datasetSelectionScore(datasetResult.response);
      return {
        artifactsDir,
        commandResult: datasetResult.commandResult,
        datasetEvaluation: datasetResult.response,
        evaluation: datasetEvaluationToResult(datasetResult.response),
        score: selectionScore.primary,
        selectionScore,
      };
    },
    kind: "dataset-adapter",
    label,
  };
}

function createModLearningEvaluator(params: {
  options: RunModLearningOptions;
  runDir: string;
}): ModLearningEvaluator {
  if (params.options.dataset) {
    return createDatasetAdapterEvaluator({
      dataset: params.options.dataset,
      runDir: params.runDir,
    });
  }
  return createScenarioSuiteEvaluator({
    runDir: params.runDir,
    spec: params.options.spec,
  });
}

function renderMarkerSection(label: string, checks: MarkerCheck[]): string[] {
  if (checks.length === 0) return [`- ${label}: none configured`];
  return [
    `- ${label}:`,
    ...checks.map(
      (check) => `  - ${check.present ? "✅" : "❌"} ${check.marker}`,
    ),
  ];
}

function renderDatasetEvaluationSection(
  evaluation: DatasetCandidateEvaluation | undefined,
): string[] {
  if (!evaluation) return [];
  return [
    "## Dataset evaluation",
    "",
    `- Dataset: ${evaluation.dataset}`,
    ...(evaluation.subset ? [`- Subset: ${evaluation.subset}`] : []),
    `- Pass rate: ${renderDatasetScore(evaluation.score)}`,
    ...(evaluation.score.costUsd !== undefined
      ? [`- Cost: $${evaluation.score.costUsd.toFixed(4)}`]
      : []),
    ...(evaluation.score.durationMs !== undefined
      ? [`- Duration: ${evaluation.score.durationMs}ms`]
      : []),
    ...(evaluation.reportPath ? [`- Report: ${evaluation.reportPath}`] : []),
    ...(evaluation.artifactsDir
      ? [`- Artifacts: ${evaluation.artifactsDir}`]
      : []),
    ...(evaluation.summary ? ["", evaluation.summary] : []),
    "",
    "| Task | Status | Cost | Duration | Report | Raw trace |",
    "| --- | --- | ---: | ---: | --- | --- |",
    ...evaluation.tasks.map(
      (task) =>
        `| ${task.taskId}${task.trial !== undefined ? ` #${task.trial}` : ""} | ${task.passed ? "PASS" : "FAIL"} | ${task.costUsd ?? ""} | ${task.durationMs ?? ""} | ${task.reportPath ?? ""} | ${task.rawTracePath ?? ""} |`,
    ),
    "",
  ];
}

function renderMarkdownReport(report: ModLearningReport): string {
  const status = report.datasetEvaluation
    ? "SCORED"
    : report.passed
      ? "PASS"
      : "FAIL";
  const lines = [
    `# Mod learning report: ${report.spec.name}`,
    "",
    `- Status: ${status}`,
    `- Evaluator: ${report.evaluatorKind ?? (report.datasetEvaluation ? "dataset-adapter" : "scenario-suite")}`,
    `- Run directory: ${report.runDir}`,
    ...(report.candidateCount && report.candidateCount > 1
      ? [
          `- Candidate attempts: ${report.candidateCount}`,
          `- Selected candidate: ${report.selectedCandidateIndex ?? report.candidateIndex}`,
        ]
      : []),
    `- Candidate: ${report.candidatePath}`,
    report.datasetEvaluation
      ? `- Dataset artifacts dir: ${report.evalMemoryDir}`
      : `- Eval memory dir: ${report.evalMemoryDir}`,
    `- Generation exit: ${report.generationResult?.exitCode ?? "skipped"}`,
    `- Eval exit: ${report.evalResult?.exitCode ?? "not run"}`,
    report.datasetEvaluation
      ? `- Dataset score: ${renderDatasetScore(report.datasetEvaluation.score)}`
      : `- Marker score: ${report.score ?? markerScore(report.evaluation)}`,
    `- Promoted to: ${report.promotedToPath ?? "not promoted"}`,
    "",
    ...(report.attempts && report.attempts.length > 0
      ? [
          "## Candidate attempts",
          "",
          "| # | Status | Score | Candidate | Report |",
          "| --- | --- | ---: | --- | --- |",
          ...report.attempts.map(
            (attempt) =>
              `| ${attempt.candidateIndex} | ${attempt.passed ? "PASS" : "FAIL"} | ${attempt.score} | ${attempt.candidatePath} | ${attempt.reportPath} |`,
          ),
          "",
        ]
      : []),
    ...renderDatasetEvaluationSection(report.datasetEvaluation),
    ...(report.evaluation.scenarioResults &&
    report.evaluation.scenarioResults.length > 0
      ? [
          "## Evaluation scenarios",
          "",
          "| Scenario | Status | Eval exit | Memory dir |",
          "| --- | --- | ---: | --- |",
          ...report.evaluation.scenarioResults.map(
            (scenario) =>
              `| ${scenario.name} | ${scenario.passed ? "PASS" : "FAIL"} | ${scenario.evalExit ?? "not run"} | ${scenario.evalMemoryDir} |`,
          ),
          "",
        ]
      : []),
    "## Marker checks",
    ...renderMarkerSection(
      "Required result markers",
      report.evaluation.requiredResultMarkers,
    ),
    ...renderMarkerSection(
      "Required trace markers",
      report.evaluation.requiredTraceMarkers,
    ),
    ...renderMarkerSection(
      "Forbidden result markers",
      report.evaluation.forbiddenResultMarkers,
    ),
    ...renderMarkerSection(
      "Forbidden trace markers",
      report.evaluation.forbiddenTraceMarkers,
    ),
    "",
    "## Extracted result",
    "",
    "```text",
    report.evaluation.resultText || "(empty)",
    "```",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

interface RunModLearningCandidateParams {
  baseEnv: NodeJS.ProcessEnv;
  candidateCount: number;
  candidateFileName: string;
  candidateIndex: number;
  cliArgsPrefix: string[];
  cliCommand: string;
  historyPath?: string;
  options: RunModLearningOptions;
  previousAttemptDirs: string[];
  repoRoot: string;
  runner: CommandRunner;
  runDir: string;
  topLevelRunDir: string;
}

async function runModLearningCandidate(
  params: RunModLearningCandidateParams,
): Promise<ModLearningReport> {
  const { options, repoRoot, runDir, topLevelRunDir } = params;
  const candidateDir = path.join(runDir, "mods");
  const candidatePath = path.join(candidateDir, params.candidateFileName);
  const evaluator = createModLearningEvaluator({ options, runDir });
  const evalMemoryDir = evaluator.artifactsDir;

  const emitProgress = (phase: ModLearningProgressPhase, message: string) => {
    options.onProgress?.({
      candidateCount: params.candidateCount,
      candidateIndex: params.candidateIndex,
      candidatePath,
      candidateRunDir: runDir,
      message,
      phase,
      runDir: topLevelRunDir,
    });
  };

  emitProgress(
    "preparing",
    params.candidateCount > 1
      ? `Preparing candidate ${params.candidateIndex}/${params.candidateCount}`
      : "Preparing mod learning run",
  );
  await mkdir(candidateDir, { recursive: true });
  await writeJsonArtifact(path.join(runDir, "env.snapshot.json"), options.spec);

  let generationResult: CommandRunResult | null = null;
  if (options.candidateSourcePath) {
    emitProgress("generating", "Copying candidate mod");
    await copyFile(
      path.resolve(repoRoot, options.candidateSourcePath),
      candidatePath,
    );
  } else if (!options.skipGeneration) {
    emitProgress(
      "generating",
      params.candidateCount > 1
        ? `Generating candidate mod ${params.candidateIndex}/${params.candidateCount}`
        : "Generating candidate mod",
    );
    const promptHistory: ModLearningPromptHistory = {
      candidateCount: params.candidateCount,
      candidateIndex: params.candidateIndex,
      previousAttemptDirs: params.previousAttemptDirs,
    };
    if (params.historyPath) promptHistory.historyPath = params.historyPath;
    const generationPrompt = buildModLearningPrompt(
      options.spec,
      candidatePath,
      promptHistory,
    );
    const generationArgs = [
      ...params.cliArgsPrefix,
      ...buildHeadlessArgs(generationPrompt, {
        backend: options.backend,
        maxTurns: 12,
        model: options.generationModel,
        noMods: true,
        outputFormat: "json",
      }),
    ];
    await writeFile(
      path.join(runDir, "generation-prompt.md"),
      generationPrompt,
      "utf8",
    );
    generationResult = await params.runner(params.cliCommand, generationArgs, {
      cwd: repoRoot,
      env: {
        ...params.baseEnv,
        LETTA_DISABLE_EXTENSIONS: "1",
        LETTA_DISABLE_MODS: "1",
      },
      timeoutMs: 15 * 60 * 1000,
    });
    await writeCommandArtifacts(
      path.join(runDir, "generation"),
      params.cliCommand,
      generationArgs,
      generationResult,
    );
  }

  const candidateExists = await fileExists(candidatePath);

  let evalResult: CommandRunResult | null = null;
  let datasetEvaluation: DatasetCandidateEvaluation | undefined;
  let evaluatorKind = evaluator.kind;
  let score = 0;
  let selectionScore: ModLearningCandidateSelectionScore = {
    kind: evaluator.kind,
    passed: false,
    primary: 0,
  };
  let evaluation: ModLearningEvaluationResult = {
    forbiddenResultMarkers: [],
    forbiddenTraceMarkers: [],
    requiredResultMarkers: [],
    requiredTraceMarkers: [],
    resultText: "",
    passed: false,
  };

  if (candidateExists) {
    emitProgress(
      "evaluating",
      `${
        params.candidateCount > 1
          ? `Evaluating candidate mod ${params.candidateIndex}/${params.candidateCount}`
          : "Evaluating candidate mod"
      } with ${evaluator.label}`,
    );
    const evaluatorResult = await evaluator.evaluate({
      backend: options.backend,
      baseEnv: params.baseEnv,
      candidate: {
        dir: candidateDir,
        fileName: params.candidateFileName,
        index: params.candidateIndex,
        path: candidatePath,
      },
      cliArgsPrefix: params.cliArgsPrefix,
      cliCommand: params.cliCommand,
      evalModel: options.evalModel,
      repoRoot,
      runDir,
      runner: params.runner,
    });
    evalResult = evaluatorResult.commandResult;
    datasetEvaluation = evaluatorResult.datasetEvaluation;
    evaluation = evaluatorResult.evaluation;
    evaluatorKind = evaluator.kind;
    score = evaluatorResult.score;
    selectionScore = evaluatorResult.selectionScore;
  }

  const passed = candidateExists && evaluation.passed;
  let promotedToPath: string | null = null;
  if (passed && options.promoteToPath) {
    emitProgress("promoting", "Promoting passing candidate mod");
    promotedToPath = path.resolve(repoRoot, options.promoteToPath);
    await mkdir(path.dirname(promotedToPath), { recursive: true });
    await copyFile(candidatePath, promotedToPath);
  }

  const reportPath = path.join(runDir, "report.md");
  emitProgress("writing-report", "Writing mod learning report");
  const report: ModLearningReport = {
    candidateCount: params.candidateCount,
    candidateIndex: params.candidateIndex,
    candidatePath,
    datasetEvaluation,
    evaluatorKind,
    evalMemoryDir,
    evalResult,
    evaluation,
    generationResult,
    passed,
    promotedToPath,
    reportPath,
    runDir,
    score,
    selectionScore,
    spec: options.spec,
  };
  await writeJsonArtifact(path.join(runDir, "report.json"), report);
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  emitProgress(
    "done",
    params.candidateCount > 1
      ? `Candidate ${params.candidateIndex}/${params.candidateCount} ${report.passed ? "passed" : "failed"}`
      : report.passed
        ? "mod learning passed"
        : "mod learning failed",
  );
  return report;
}

export async function runModLearning(
  options: RunModLearningOptions,
): Promise<ModLearningReport> {
  const candidateCount = normalizeCandidateCount(options.candidateCount);
  if (candidateCount > 1 && options.candidateSourcePath) {
    throw new Error("--candidates cannot be combined with --candidate");
  }
  if (candidateCount > 1 && options.skipGeneration) {
    throw new Error("--candidates cannot be combined with --skip-generation");
  }

  const repoRoot = path.resolve(options.repoRoot);
  const runDir = path.resolve(
    repoRoot,
    options.runDir ??
      defaultModLearningRunDirectory(
        options.spec,
        options.outputBaseDir ?? path.join(".letta", "mod-learning-runs"),
      ),
  );
  const candidateFileName = normalizeCandidateFileName(
    options.spec,
    options.candidateFileName,
  );
  const runner = options.commandRunner ?? defaultCommandRunner;
  const cliCommand = options.cliCommand ?? "bun";
  const cliArgsPrefix = options.cliArgsPrefix ?? ["run", "dev"];
  const baseEnv = options.env ?? process.env;

  await mkdir(runDir, { recursive: true });
  await writeJsonArtifact(path.join(runDir, "env.snapshot.json"), options.spec);

  if (candidateCount === 1) {
    return runModLearningCandidate({
      baseEnv,
      candidateCount,
      candidateFileName,
      candidateIndex: 1,
      cliArgsPrefix,
      cliCommand,
      options,
      previousAttemptDirs: [],
      repoRoot,
      runner,
      runDir,
      topLevelRunDir: runDir,
    });
  }

  const historyPath = path.join(runDir, "history.md");
  const attempts: ModLearningAttemptSummary[] = [];
  const reports: ModLearningReport[] = [];
  await writeHistoryIndex({ attempts, historyPath, spec: options.spec });

  for (
    let candidateIndex = 1;
    candidateIndex <= candidateCount;
    candidateIndex += 1
  ) {
    const candidateRunDir = path.join(
      runDir,
      "candidates",
      candidateDirectoryName(candidateIndex),
    );
    const report = await runModLearningCandidate({
      baseEnv,
      candidateCount,
      candidateFileName,
      candidateIndex,
      cliArgsPrefix,
      cliCommand,
      historyPath,
      options: { ...options, promoteToPath: undefined },
      previousAttemptDirs: reports.map((attempt) => attempt.runDir),
      repoRoot,
      runner,
      runDir: candidateRunDir,
      topLevelRunDir: runDir,
    });
    reports.push(report);
    attempts.push(summarizeAttempt(report));
    await writeHistoryIndex({ attempts, historyPath, spec: options.spec });
  }

  const selectedReport = selectBestReport(reports);
  const selectedCandidateIndex = selectedReport.candidateIndex ?? 1;
  let promotedToPath: string | null = null;
  if (selectedReport.passed && options.promoteToPath) {
    options.onProgress?.({
      candidateCount,
      candidateIndex: selectedCandidateIndex,
      candidatePath: selectedReport.candidatePath,
      candidateRunDir: selectedReport.runDir,
      message: "Promoting selected candidate mod",
      phase: "promoting",
      runDir,
    });
    promotedToPath = path.resolve(repoRoot, options.promoteToPath);
    await mkdir(path.dirname(promotedToPath), { recursive: true });
    await copyFile(selectedReport.candidatePath, promotedToPath);
  }

  const reportPath = path.join(runDir, "report.md");
  const report: ModLearningReport = {
    ...selectedReport,
    attempts,
    candidateCount,
    promotedToPath,
    reportPath,
    runDir,
    selectedCandidateIndex,
  };
  options.onProgress?.({
    candidateCount,
    candidateIndex: selectedCandidateIndex,
    candidatePath: report.candidatePath,
    candidateRunDir: selectedReport.runDir,
    message: "Writing mod learning summary report",
    phase: "writing-report",
    runDir,
  });
  await writeHistoryIndex({
    attempts,
    historyPath,
    selectedCandidateIndex,
    spec: options.spec,
  });
  await writeJsonArtifact(path.join(runDir, "report.json"), report);
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  options.onProgress?.({
    candidateCount,
    candidateIndex: selectedCandidateIndex,
    candidatePath: report.candidatePath,
    candidateRunDir: selectedReport.runDir,
    message: report.passed ? "mod learning passed" : "mod learning failed",
    phase: "done",
    runDir,
  });
  return report;
}

export async function readModLearningEnv(
  envPath: string,
): Promise<ModLearningSpec> {
  return JSON.parse(await readFile(envPath, "utf8")) as ModLearningSpec;
}
