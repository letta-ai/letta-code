import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import { createModEngine } from "@/mods/mod-engine";
import type {
  ModContext,
  ModToolStartEvent,
  ModTurnStartEvent,
} from "@/mods/types";

export type HeadlessLearningOutputFormat = "json" | "stream-json";

export interface ModLearningExample {
  input: string;
  expected?: string;
  notes?: string;
}

export interface ModLearningEvaluationScenarioSpec {
  name?: string;
  assertions?: ModLearningAssertion[];
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

export type ModLearningAssertion =
  | {
      type: "mod_loads";
      expectedLoadedCount?: number;
    }
  | {
      type: "turn_start_injects_message";
      contains?: string | string[];
      input?: Array<Record<string, unknown>>;
      notContains?: string | string[];
      role?: string;
    }
  | {
      type: "tool_start_rewrites_args";
      args: Record<string, unknown>;
      expectArgs: Record<string, unknown>;
      toolName: string;
    }
  | {
      type: "tool_start_preserves_args";
      args: Record<string, unknown>;
      toolName: string;
    };

export interface CommandRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStdout?: (chunk: string) => void;
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

export interface ModLearningAssertionCheck {
  details?: Record<string, unknown>;
  label: string;
  message: string;
  passed: boolean;
}

export interface ModLearningEvaluationResult {
  assertionChecks: ModLearningAssertionCheck[];
  forbiddenResultMarkers: MarkerCheck[];
  forbiddenTraceMarkers: MarkerCheck[];
  requiredResultMarkers: MarkerCheck[];
  requiredTraceMarkers: MarkerCheck[];
  resultText: string;
  passed: boolean;
  scenarioResults?: ModLearningScenarioEvaluationResult[];
}

export interface ModLearningScenarioEvaluationResult {
  assertionChecks: ModLearningAssertionCheck[];
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
  env?: NodeJS.ProcessEnv;
  evalModel?: string;
  generationModel?: string;
  onProgress?: (progress: ModLearningProgress) => void;
  outputBaseDir?: string;
  promoteToPath?: string;
  repoRoot: string;
  runDir?: string;
  scenarioLimit?: number;
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

export interface ModLearningHeadlessConversation {
  agentId?: string;
  conversationId: string;
  label: string;
}

export interface ModLearningProgress {
  activeConversation?: ModLearningHeadlessConversation;
  attempts?: ModLearningAttemptSummary[];
  candidateIndex?: number;
  candidatePath: string;
  candidateRunDir?: string;
  candidateCount?: number;
  message: string;
  maxScore?: number;
  passed?: boolean;
  phase: ModLearningProgressPhase;
  runDir: string;
  score?: number;
  selectedCandidateIndex?: number;
}

export interface ModLearningAttemptSummary {
  candidateIndex: number;
  candidatePath: string;
  evalExit: number | null | "assertions only" | "not run";
  generationExit: number | null | "skipped";
  missingRequiredResultMarkers: string[];
  missingRequiredTraceMarkers: string[];
  passed: boolean;
  presentForbiddenResultMarkers: string[];
  presentForbiddenTraceMarkers: string[];
  progressHtmlPath?: string;
  progressJsonlPath?: string;
  reportHtmlPath?: string;
  reportPath: string;
  runDir: string;
  maxScore?: number;
  score: number;
}

interface ModLearningScenarioArtifactManifest {
  assertionsResultPath?: string;
  evalCommandPath?: string;
  evalMemoryDir: string;
  evalResultPath?: string;
  evalStderrPath?: string;
  evalStdoutPath?: string;
  index: number;
  name: string;
  promptPath?: string;
  runDir: string;
}

interface ModLearningCandidateManifest {
  artifacts: {
    candidatePath: string;
    envSnapshotPath?: string;
    evalDir: string;
    generationCommandPath?: string;
    generationPromptPath?: string;
    generationResultPath?: string;
    generationStderrPath?: string;
    generationStdoutPath?: string;
    reportHtmlPath?: string;
    reportJsonPath: string;
    reportMarkdownPath: string;
    scenarioArtifacts: ModLearningScenarioArtifactManifest[];
  };
  candidateIndex: number;
  evalExit: number | null | "assertions only" | "not run";
  generationExit: number | null | "skipped";
  kind: "mod_learning_candidate_manifest";
  passed: boolean;
  runDir: string;
  score: number;
  version: 1;
}

interface ModLearningHistoryManifest {
  attemptCount: number;
  attempts: Array<
    ModLearningAttemptSummary & {
      manifestPath: string;
      reportJsonPath: string;
    }
  >;
  historyMarkdownPath: string;
  historyManifestPath: string;
  kind: "mod_learning_history_manifest";
  proposerGuidePath: string;
  runDir: string;
  selectedCandidateIndex?: number;
  spec: {
    name: string;
    slug?: string;
    targetModName?: string;
  };
  version: 1;
}

export interface ModLearningReport {
  attempts?: ModLearningAttemptSummary[];
  candidateCount?: number;
  candidateIndex?: number;
  candidatePath: string;
  evalMemoryDir: string;
  evalResult: CommandRunResult | null;
  evaluation: ModLearningEvaluationResult;
  generationResult: CommandRunResult | null;
  passed: boolean;
  promotedToPath: string | null;
  progressHtmlPath?: string;
  progressJsonlPath?: string;
  reportHtmlPath?: string;
  reportPath: string;
  runDir: string;
  maxScore?: number;
  score?: number;
  selectedCandidateIndex?: number;
  spec: ModLearningSpec;
  stoppedEarlyAt?: number;
  stoppedEarlyReason?: string;
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
  onScenarioProgress?: (progress: {
    activeConversation?: ModLearningHeadlessConversation;
    evaluation: ModLearningEvaluationResult;
    scenarioCount: number;
    scenarioIndex: number;
    scenarioName: string;
    score: number;
  }) => void;
  repoRoot: string;
  runDir: string;
  runner: CommandRunner;
}

interface ModLearningEvaluatorResult {
  artifactsDir: string;
  commandResult: CommandRunResult | null;
  evaluation: ModLearningEvaluationResult;
  score: number;
}

interface ModLearningEvaluator {
  artifactsDir: string;
  evaluate: (
    context: ModLearningEvaluatorContext,
  ) => Promise<ModLearningEvaluatorResult>;
  label: string;
}

export interface ModLearningPromptHistory {
  candidateCount?: number;
  candidateIndex?: number;
  historyManifestPath?: string;
  historyPath?: string;
  proposerGuidePath?: string;
  previousAttemptDirs?: string[];
}

interface HeadlessCommandOptions {
  backend?: string;
  maxTurns?: number;
  model?: string;
  noMods?: boolean;
  outputFormat: HeadlessLearningOutputFormat;
  personality?: string;
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

function asStringArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function valuesMatch(actual: unknown, expected: unknown): boolean {
  return stableJson(actual) === stableJson(expected);
}

function objectContains(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([key, value]) =>
    valuesMatch(actual[key], value),
  );
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => stringifyMessageContent(part)).join("");
  }
  if (typeof content === "object" && content !== null) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return content == null ? "" : JSON.stringify(content);
}

function defaultTurnStartInput(): ModTurnStartEvent["input"] {
  return [
    {
      type: "message",
      role: "user",
      content: "Install a Python package.",
    },
  ];
}

function assertionLabel(
  assertion: ModLearningAssertion,
  index: number,
): string {
  switch (assertion.type) {
    case "mod_loads":
      return `${index + 1}. mod_loads`;
    case "turn_start_injects_message":
      return `${index + 1}. turn_start_injects_message`;
    case "tool_start_rewrites_args":
      return `${index + 1}. tool_start_rewrites_args ${assertion.toolName}`;
    case "tool_start_preserves_args":
      return `${index + 1}. tool_start_preserves_args ${assertion.toolName}`;
  }
}

function createAssertionCheck(
  assertion: ModLearningAssertion,
  index: number,
  passed: boolean,
  message: string,
  details?: Record<string, unknown>,
): ModLearningAssertionCheck {
  return {
    ...(details ? { details } : {}),
    label: assertionLabel(assertion, index),
    message,
    passed,
  };
}

function createAssertionModContext(repoRoot: string): ModContext {
  return {
    app: { version: "mod-learning-eval" },
    backgroundAgents: [],
    contextWindow: {
      currentUsage: null,
      remainingPercentage: null,
      size: 200000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      usedPercentage: null,
    },
    cost: {
      totalApiDurationMs: 0,
      totalCostUsd: null,
      totalDurationMs: 0,
      totalLinesAdded: null,
      totalLinesRemoved: null,
    },
    cwd: repoRoot,
    lastRunId: null,
    memfs: { enabled: false, memoryDir: null },
    model: {
      displayName: "mod-learning-eval",
      id: "mod-learning-eval",
      provider: "local",
      reasoningEffort: null,
    },
    networkPhase: null,
    permissionMode: "standard",
    reflection: { mode: null, stepCount: 0 },
    sessionId: "mod-learning-eval-conversation",
    systemPromptId: null,
    terminalWidth: 80,
    toolset: "default",
    agent: { id: "mod-learning-eval-agent", name: "Mod Learning Eval" },
    workspace: {
      cwd: repoRoot,
      currentDir: repoRoot,
      projectDir: repoRoot,
    },
  };
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

function combineAssertions(
  base: ModLearningAssertion[] | undefined,
  override: ModLearningAssertion[] | undefined,
): ModLearningAssertion[] | undefined {
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
    if (!evaluation.prompt?.trim() && !evaluation.assertions?.length) {
      throw new Error(
        "evaluation.prompt or evaluation.assertions is required when no scenarios are configured",
      );
    }
    return [{ name: "default", spec: evaluation }];
  }

  return scenarios.map((scenario, index) => {
    const prompt = scenario.prompt ?? evaluation.prompt;
    const assertions = combineAssertions(
      evaluation.assertions,
      scenario.assertions,
    );
    if (!prompt?.trim() && !assertions?.length) {
      throw new Error(`evaluation.scenarios[${index}].prompt is required`);
    }
    return {
      name: scenarioName(index, scenario),
      spec: {
        assertions,
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

function normalizeScenarioLimit(
  scenarioLimit: number | undefined,
): number | undefined {
  if (scenarioLimit === undefined) return undefined;
  if (!Number.isInteger(scenarioLimit) || scenarioLimit < 1) {
    throw new Error("scenarioLimit must be a positive integer");
  }
  return scenarioLimit;
}

function limitedEvaluationScenarios(
  evaluation: ModLearningEvaluationSpec,
  scenarioLimit: number | undefined,
): Array<{ name: string; spec: ModLearningEvaluationScenarioSpec }> {
  const scenarios = evaluationScenarios(evaluation);
  return scenarioLimit === undefined
    ? scenarios
    : scenarios.slice(0, scenarioLimit);
}

function maxScenarioScore(scenario: ModLearningEvaluationScenarioSpec): number {
  return (
    (scenario.assertions?.length ?? 0) +
    (scenario.requiredResultMarkers?.length ?? 0) +
    (scenario.requiredTraceMarkers?.length ?? 0) +
    (scenario.forbiddenResultMarkers?.length ?? 0) +
    (scenario.forbiddenTraceMarkers?.length ?? 0)
  );
}

function maxEvaluationScore(
  evaluation: ModLearningEvaluationSpec,
  scenarioLimit: number | undefined,
): number {
  return limitedEvaluationScenarios(evaluation, scenarioLimit).reduce(
    (total, scenario) => total + maxScenarioScore(scenario.spec),
    0,
  );
}

function specForScenarioLimit(
  spec: ModLearningSpec,
  scenarioLimit: number | undefined,
): ModLearningSpec {
  if (scenarioLimit === undefined || !spec.evaluation.scenarios?.length) {
    return spec;
  }
  return {
    ...spec,
    evaluation: {
      ...spec.evaluation,
      scenarios: spec.evaluation.scenarios.slice(0, scenarioLimit),
    },
  };
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

async function existingPath(filePath: string): Promise<string | undefined> {
  return (await fileExists(filePath)) ? filePath : undefined;
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
  const renderedPrompt = prompt.replace(
    /\$\{MEMORY_DIR\}|\$MEMORY_DIR/g,
    () => memoryDir,
  );
  return [
    "You are running one isolated mod-learning evaluation scenario.",
    "Follow only the scenario instructions below. Do not search this repository for other evaluation scenarios, do not run /mods learn, and do not run test suites unless the scenario explicitly asks you to do so.",
    "If the scenario asks for a final answer marker, provide that marker directly once the scenario-specific work is complete.",
    "",
    "Scenario instructions:",
    renderedPrompt,
  ].join("\n");
}

function extractHeadlessConversation(value: Record<string, unknown>): {
  agentId?: string;
  conversationId?: string;
} {
  const payload =
    value.type === "stream_event" &&
    value.event &&
    typeof value.event === "object"
      ? (value.event as Record<string, unknown>)
      : value;
  const agentId =
    typeof payload.agent_id === "string" ? payload.agent_id : undefined;
  const conversationId =
    typeof payload.conversation_id === "string"
      ? payload.conversation_id
      : undefined;
  return { agentId, conversationId };
}

function createHeadlessConversationObserver(
  label: string,
  onConversation: (conversation: ModLearningHeadlessConversation) => void,
): (chunk: string) => void {
  let buffer = "";
  let emittedConversationId: string | null = null;
  const emitFromLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const { agentId, conversationId } = extractHeadlessConversation(parsed);
      if (!conversationId || conversationId === emittedConversationId) return;
      emittedConversationId = conversationId;
      onConversation({
        ...(agentId ? { agentId } : {}),
        conversationId,
        label,
      });
    } catch {
      // Ignore non-JSON diagnostics and incomplete chunks; stdout is still
      // persisted as an artifact.
    }
  };
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      emitFromLine(line);
    }
    emitFromLine(buffer);
  };
}

function renderAssertionSummary(
  assertions: ModLearningAssertion[] | undefined,
): string {
  if (!assertions?.length) return "";
  return assertions
    .map((assertion, index) => {
      switch (assertion.type) {
        case "mod_loads":
          return `${index + 1}. mod_loads${
            assertion.expectedLoadedCount !== undefined
              ? ` (expected loaded count: ${assertion.expectedLoadedCount})`
              : ""
          }`;
        case "turn_start_injects_message":
          return `${index + 1}. turn_start_injects_message contains ${asStringArray(
            assertion.contains,
          ).join(", ")}`;
        case "tool_start_rewrites_args":
          return `${index + 1}. tool_start_rewrites_args ${assertion.toolName}: ${stableJson(
            assertion.args,
          )} -> ${stableJson(assertion.expectArgs)}`;
        case "tool_start_preserves_args":
          return `${index + 1}. tool_start_preserves_args ${assertion.toolName}: ${stableJson(
            assertion.args,
          )}`;
      }
      return "";
    })
    .join("\n");
}

function renderEvaluationSummaryForPrompt(spec: ModLearningSpec): string {
  const scenarios = evaluationScenarios(spec.evaluation);
  if (scenarios.length === 1) {
    const scenario = scenarios[0]?.spec;
    if (!scenario) return "";
    const assertionSummary = renderAssertionSummary(scenario.assertions);
    return [
      scenario.prompt ? `Prompt: ${scenario.prompt}` : "",
      assertionSummary ? `Executable assertions:\n${assertionSummary}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return scenarios
    .map(({ name, spec: scenario }, index) => {
      const requiredResultMarkers = scenario.requiredResultMarkers?.length
        ? `\nRequired result markers: ${scenario.requiredResultMarkers.join(", ")}`
        : "";
      const forbiddenResultMarkers = scenario.forbiddenResultMarkers?.length
        ? `\nForbidden result markers: ${scenario.forbiddenResultMarkers.join(", ")}`
        : "";
      const assertions = renderAssertionSummary(scenario.assertions);
      return `Scenario ${index + 1} (${name}):${
        scenario.prompt ? `\nPrompt: ${scenario.prompt}` : ""
      }${assertions ? `\nExecutable assertions:\n${assertions}` : ""}${requiredResultMarkers}${forbiddenResultMarkers}`;
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
      ? `\nOptimization iteration: ${candidateIndex} of ${candidateCount}`
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
      ? `\nPrior candidate feedback is available on disk. Before writing this candidate, inspect the previous report(s), candidate source, stdout/stderr, assertion results, and eval artifacts to avoid repeating failures. Treat these files as read-only.\n${history?.proposerGuidePath ? `\nStart with the proposer filesystem guide: ${history.proposerGuidePath}\n` : ""}${history?.historyManifestPath ? `\nMachine-readable history manifest: ${history.historyManifestPath}\n` : ""}${history?.historyPath ? `\nHuman summary file: ${history.historyPath}\n` : ""}\nPrior attempt directories (each contains manifest.json, report.md, report.json, mods/, generation logs, and eval artifacts):\n${previousAttemptDirs
          .map((attemptDir, index) => `${index + 1}. ${attemptDir}`)
          .join(
            "\n",
          )}\n\nUse \`cat\`, \`rg\`, \`ls\`, and \`diff\` to inspect the filesystem. Prefer reading the most relevant failed scenario artifacts over relying only on this prompt summary.\n`
      : "";
  const evaluationSummary = renderEvaluationSummaryForPrompt(spec);

  return `You are dogfooding Letta Code's trusted local mod system. Learn a minimal mod from the target env and write the candidate mod file.\n\nTarget: ${spec.name}${attemptLabel}\nObjective: ${spec.objective}\nCandidate file, absolute path: ${candidatePath}\n\nHard rules:\n- Edit only the candidate file above. Do not modify repository source, docs, package files, tests, or git state.\n- Export either \`activate(letta)\` or a default function.\n- Use the trusted local mod API directly; do not import from "@/..." or from this repo's src files.\n- Prefer a small implementation that satisfies the behavior over a polished product mod.\n- If you register an eval-facing tool, set \`requiresApproval: false\` and keep it read-only.\n- Do not run tests or lint. Write the candidate file and stop.\n${diversitySection}${historySection}\nMod API surface guide:\n- Use \`turn_start\` for policy/guidance that should influence model planning.\n- Use \`tool_start\` for tool argument inspection, normalization, rewrites, or blocking-adjacent behavior before execution.\n- Register a tool only when the agent needs a new callable capability or observable state.\n- Pick the narrowest surface that directly satisfies the env; a reminder alone is not enough when the env asks for tool-boundary behavior.\n\nMinimal mod API reminder:\n\`\`\`ts\nexport function activate(letta) {\n  const disposers = [];\n  if (letta.capabilities.events.tools) {\n    disposers.push(letta.events.on("tool_start", (event) => {\n      // Use this for command/argument rewrites before tool execution.\n      if (event.toolName === "exec_command" && typeof event.args.cmd === "string") {\n        const rewritten = event.args.cmd.replace("old command", "new command");\n        if (rewritten !== event.args.cmd) {\n          return { args: { ...event.args, cmd: rewritten } };\n        }\n      }\n    }));\n  }\n  if (letta.capabilities.events.turns) {\n    disposers.push(letta.events.on("turn_start", (event) => {\n      // event.input is an array of message/approval objects. Do not append\n      // strings to existing content because content may be structured parts.\n      event.input = [\n        ...event.input,\n        { type: "message", role: "system", content: "mod reminder" },\n      ];\n      return { input: event.input };\n    }));\n  }\n  if (letta.capabilities.tools) {\n    disposers.push(letta.tools.register({\n      name: "example_tool",\n      description: "Short tool description",\n      parameters: { type: "object", properties: {}, additionalProperties: false },\n      requiresApproval: false,\n      parallelSafe: true,\n      run(ctx) {\n        // For conversation-scoped state, use ctx.conversation.id or\n        // ctx.getContext().sessionId as the key.\n        return "ok";\n      },\n    }));\n  }\n  return () => disposers.reverse().forEach((dispose) => dispose());\n}\n\`\`\`\n\nRequirements:\n${requirements}\n${hints ? `\nUseful API/implementation hints:\n${hints}\n` : ""}${examples ? `\nDemos:\n${examples}\n` : ""}\nEvaluation scenario(s) this candidate must satisfy:\n${evaluationSummary}\n\nWrite the candidate mod now, then reply with only a concise summary and the file path.`;
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
  if (options.personality) args.push("--personality", options.personality);
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
    assertionChecks: [],
    forbiddenResultMarkers,
    forbiddenTraceMarkers,
    requiredResultMarkers,
    requiredTraceMarkers,
    resultText,
    passed,
  };
}

async function evaluateModLearningAssertions(params: {
  assertions: ModLearningAssertion[] | undefined;
  cacheDirectory: string;
  candidateDir: string;
  repoRoot: string;
}): Promise<ModLearningEvaluationResult> {
  const assertions = params.assertions ?? [];
  if (assertions.length === 0) {
    return {
      assertionChecks: [],
      forbiddenResultMarkers: [],
      forbiddenTraceMarkers: [],
      passed: true,
      requiredResultMarkers: [],
      requiredTraceMarkers: [],
      resultText: "",
    };
  }

  const context = createAssertionModContext(params.repoRoot);
  const engine = createModEngine({
    cacheDirectory: params.cacheDirectory,
    getClient: async () => ({}) as unknown as Letta,
    globalModsDirectory: params.candidateDir,
  });

  try {
    await engine.reload();
    const snapshot = engine.getSnapshot();
    const checks: ModLearningAssertionCheck[] = [];

    for (const [index, assertion] of assertions.entries()) {
      if (assertion.type === "mod_loads") {
        const expectedLoadedCount = assertion.expectedLoadedCount;
        const diagnostics = snapshot.diagnostics.map((diagnostic) => ({
          message: diagnostic.error.message,
          phase: diagnostic.phase,
          path: diagnostic.owner.path,
          severity: diagnostic.severity ?? "error",
        }));
        const expectedCountMatches =
          expectedLoadedCount === undefined ||
          snapshot.loadedPaths.length === expectedLoadedCount;
        const passed =
          snapshot.diagnostics.length === 0 &&
          snapshot.loadedPaths.length > 0 &&
          expectedCountMatches;
        checks.push(
          createAssertionCheck(
            assertion,
            index,
            passed,
            passed
              ? "candidate mod loaded without diagnostics"
              : "candidate mod failed to load as expected",
            {
              diagnostics,
              expectedLoadedCount,
              loadedCount: snapshot.loadedPaths.length,
              loadedPaths: snapshot.loadedPaths,
            },
          ),
        );
        continue;
      }

      if (assertion.type === "turn_start_injects_message") {
        const input = structuredClone(
          (assertion.input as ModTurnStartEvent["input"] | undefined) ??
            defaultTurnStartInput(),
        );
        const originalInput = structuredClone(input);
        const event: ModTurnStartEvent = {
          agentId: context.agent.id,
          conversationId: context.sessionId,
          input,
        };
        const emission = await engine.emitEvent("turn_start", event, context);
        const newMessages = event.input.slice(originalInput.length);
        const role = assertion.role ?? "system";
        const matchingMessages = newMessages.filter(
          (message) => (message as { role?: unknown }).role === role,
        );
        const matchingText = matchingMessages
          .map((message) =>
            stringifyMessageContent((message as { content?: unknown }).content),
          )
          .join("\n");
        const required = asStringArray(assertion.contains);
        const forbidden = asStringArray(assertion.notContains);
        const hasRequired = required.every((text) =>
          matchingText.includes(text),
        );
        const hasForbidden = forbidden.some((text) =>
          matchingText.includes(text),
        );
        const preservedOriginalInput = valuesMatch(
          event.input.slice(0, originalInput.length),
          originalInput,
        );
        const passed =
          emission.handlerCount > 0 &&
          matchingMessages.length > 0 &&
          hasRequired &&
          !hasForbidden &&
          preservedOriginalInput &&
          emission.diagnostics.length === 0;
        checks.push(
          createAssertionCheck(
            assertion,
            index,
            passed,
            passed
              ? "turn_start injected the expected message"
              : "turn_start did not inject the expected message",
            {
              diagnostics: emission.diagnostics.map(
                (diagnostic) => diagnostic.error.message,
              ),
              forbidden,
              handlerCount: emission.handlerCount,
              injectedMessageCount: matchingMessages.length,
              matchingText,
              preservedOriginalInput,
              required,
              role,
            },
          ),
        );
        continue;
      }

      if (assertion.type === "tool_start_rewrites_args") {
        const event: ModToolStartEvent = {
          agentId: context.agent.id,
          args: structuredClone(assertion.args),
          conversationId: context.sessionId,
          toolCallId: "mod-learning-assertion-tool-call",
          toolName: assertion.toolName,
        };
        const emission = await engine.emitEvent("tool_start", event, context);
        const passed =
          emission.handlerCount > 0 &&
          emission.diagnostics.length === 0 &&
          objectContains(event.args, assertion.expectArgs);
        checks.push(
          createAssertionCheck(
            assertion,
            index,
            passed,
            passed
              ? "tool_start rewrote args as expected"
              : "tool_start did not rewrite args as expected",
            {
              actualArgs: event.args,
              diagnostics: emission.diagnostics.map(
                (diagnostic) => diagnostic.error.message,
              ),
              expectedArgs: assertion.expectArgs,
              handlerCount: emission.handlerCount,
              inputArgs: assertion.args,
              toolName: assertion.toolName,
            },
          ),
        );
        continue;
      }

      if (assertion.type === "tool_start_preserves_args") {
        const originalArgs = structuredClone(assertion.args);
        const event: ModToolStartEvent = {
          agentId: context.agent.id,
          args: structuredClone(assertion.args),
          conversationId: context.sessionId,
          toolCallId: "mod-learning-assertion-tool-call",
          toolName: assertion.toolName,
        };
        const emission = await engine.emitEvent("tool_start", event, context);
        const passed =
          emission.handlerCount > 0 &&
          emission.diagnostics.length === 0 &&
          valuesMatch(event.args, originalArgs);
        checks.push(
          createAssertionCheck(
            assertion,
            index,
            passed,
            passed
              ? "tool_start preserved args as expected"
              : "tool_start unexpectedly changed args",
            {
              actualArgs: event.args,
              diagnostics: emission.diagnostics.map(
                (diagnostic) => diagnostic.error.message,
              ),
              expectedArgs: originalArgs,
              handlerCount: emission.handlerCount,
              toolName: assertion.toolName,
            },
          ),
        );
      }
    }

    const resultText = checks
      .map(
        (check) =>
          `${check.passed ? "PASS" : "FAIL"} ${check.label}: ${check.message}`,
      )
      .join("\n");
    return {
      assertionChecks: checks,
      forbiddenResultMarkers: [],
      forbiddenTraceMarkers: [],
      passed: checks.every((check) => check.passed),
      requiredResultMarkers: [],
      requiredTraceMarkers: [],
      resultText,
    };
  } finally {
    engine.dispose();
  }
}

function mergeEvaluationResults(
  first: ModLearningEvaluationResult,
  second: ModLearningEvaluationResult,
): ModLearningEvaluationResult {
  return {
    assertionChecks: [...first.assertionChecks, ...second.assertionChecks],
    forbiddenResultMarkers: [
      ...first.forbiddenResultMarkers,
      ...second.forbiddenResultMarkers,
    ],
    forbiddenTraceMarkers: [
      ...first.forbiddenTraceMarkers,
      ...second.forbiddenTraceMarkers,
    ],
    passed: first.passed && second.passed,
    requiredResultMarkers: [
      ...first.requiredResultMarkers,
      ...second.requiredResultMarkers,
    ],
    requiredTraceMarkers: [
      ...first.requiredTraceMarkers,
      ...second.requiredTraceMarkers,
    ],
    resultText: [first.resultText, second.resultText]
      .filter((text) => text.trim().length > 0)
      .join("\n\n"),
  };
}

function aggregateScenarioEvaluations(
  scenarioResults: ModLearningScenarioEvaluationResult[],
): ModLearningEvaluationResult {
  return {
    assertionChecks: scenarioResults.flatMap((scenario) =>
      scenario.assertionChecks.map((check) => ({
        ...check,
        label: `${scenario.name}: ${check.label}`,
      })),
    ),
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
    ...evaluation.assertionChecks.map((check) => check.passed),
    ...evaluation.requiredResultMarkers.map((check) => check.present),
    ...evaluation.requiredTraceMarkers.map((check) => check.present),
    ...evaluation.forbiddenResultMarkers.map((check) => !check.present),
    ...evaluation.forbiddenTraceMarkers.map((check) => !check.present),
  ].filter(Boolean).length;
}

function reportScore(report: ModLearningReport): number {
  return report.score ?? markerScore(report.evaluation);
}

function isPerfectReport(report: ModLearningReport): boolean {
  return (
    report.passed &&
    report.maxScore !== undefined &&
    report.maxScore > 0 &&
    reportScore(report) >= report.maxScore
  );
}

function isAssertionOnlyReport(report: ModLearningReport): boolean {
  if (report.evalResult !== null) return false;
  if (report.generationResult && report.generationResult.exitCode !== 0)
    return false;
  const scenarioResults = report.evaluation.scenarioResults ?? [];
  if (scenarioResults.length > 0) {
    return scenarioResults.every(
      (scenario) =>
        scenario.evalExit === null && scenario.assertionChecks.length > 0,
    );
  }
  return report.evaluation.assertionChecks.length > 0;
}

function evalStatusLabel(
  report: ModLearningReport,
): number | null | "assertions only" | "not run" {
  if (isAssertionOnlyReport(report)) return "assertions only";
  return report.evalResult?.exitCode ?? "not run";
}

function evalReportLine(report: ModLearningReport): string {
  if (isAssertionOnlyReport(report)) return "- Eval: assertions only";
  return `- Eval exit: ${report.evalResult?.exitCode ?? "not run"}`;
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

  const candidateScore = reportScore(candidate);
  const incumbentScore = reportScore(incumbent);
  if (candidateScore !== incumbentScore) return candidateScore - incumbentScore;

  return (candidate.candidateIndex ?? 0) - (incumbent.candidateIndex ?? 0);
}

function compareReportsForSelection(
  candidate: ModLearningReport,
  incumbent: ModLearningReport,
): number {
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
    evalExit: evalStatusLabel(report),
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
    reportHtmlPath: report.reportHtmlPath,
    reportPath: report.reportPath,
    runDir: report.runDir,
    maxScore: report.maxScore,
    score: reportScore(report),
  };
}

function candidateManifestPath(runDir: string): string {
  return path.join(runDir, "manifest.json");
}

async function scenarioArtifactManifest(params: {
  index: number;
  report: ModLearningReport;
  scenario: ModLearningScenarioEvaluationResult;
}): Promise<ModLearningScenarioArtifactManifest> {
  const scenarioSuiteRunDir = path.join(
    params.report.runDir,
    "eval",
    `${candidateDirectoryName(params.index + 1)}-${slugify(params.scenario.name)}`,
  );
  const hasScenarioSuiteDir = await fileExists(scenarioSuiteRunDir);
  const scenarioRunDir = hasScenarioSuiteDir
    ? scenarioSuiteRunDir
    : params.report.runDir;
  const evalPrefix = path.join(scenarioRunDir, "eval");
  const assertionsResultPath = await existingPath(
    path.join(scenarioRunDir, "assertions.result.json"),
  );
  const evalCommandPath = await existingPath(`${evalPrefix}.command.txt`);
  const evalResultPath = await existingPath(`${evalPrefix}.result.json`);
  const evalStderrPath = await existingPath(`${evalPrefix}.stderr`);
  const evalStdoutPath = await existingPath(`${evalPrefix}.stdout`);
  const promptPath = await existingPath(
    hasScenarioSuiteDir
      ? path.join(scenarioRunDir, "prompt.md")
      : path.join(scenarioRunDir, "eval-prompt.md"),
  );

  return {
    ...(assertionsResultPath ? { assertionsResultPath } : {}),
    ...(evalCommandPath ? { evalCommandPath } : {}),
    evalMemoryDir: params.scenario.evalMemoryDir,
    ...(evalResultPath ? { evalResultPath } : {}),
    ...(evalStderrPath ? { evalStderrPath } : {}),
    ...(evalStdoutPath ? { evalStdoutPath } : {}),
    index: params.index + 1,
    name: params.scenario.name,
    ...(promptPath ? { promptPath } : {}),
    runDir: scenarioRunDir,
  };
}

async function buildCandidateManifest(
  report: ModLearningReport,
): Promise<ModLearningCandidateManifest> {
  const scenarioArtifacts = await Promise.all(
    (report.evaluation.scenarioResults ?? []).map((scenario, index) =>
      scenarioArtifactManifest({ index, report, scenario }),
    ),
  );
  const envSnapshotPath = await existingPath(
    path.join(report.runDir, "env.snapshot.json"),
  );
  const generationCommandPath = await existingPath(
    path.join(report.runDir, "generation.command.txt"),
  );
  const generationPromptPath = await existingPath(
    path.join(report.runDir, "generation-prompt.md"),
  );
  const generationResultPath = await existingPath(
    path.join(report.runDir, "generation.result.json"),
  );
  const generationStderrPath = await existingPath(
    path.join(report.runDir, "generation.stderr"),
  );
  const generationStdoutPath = await existingPath(
    path.join(report.runDir, "generation.stdout"),
  );

  return {
    artifacts: {
      candidatePath: report.candidatePath,
      ...(envSnapshotPath ? { envSnapshotPath } : {}),
      evalDir: report.evalMemoryDir,
      ...(generationCommandPath ? { generationCommandPath } : {}),
      ...(generationPromptPath ? { generationPromptPath } : {}),
      ...(generationResultPath ? { generationResultPath } : {}),
      ...(generationStderrPath ? { generationStderrPath } : {}),
      ...(generationStdoutPath ? { generationStdoutPath } : {}),
      ...(report.reportHtmlPath
        ? { reportHtmlPath: report.reportHtmlPath }
        : {}),
      reportJsonPath: path.join(report.runDir, "report.json"),
      reportMarkdownPath: report.reportPath,
      scenarioArtifacts,
    },
    candidateIndex: report.candidateIndex ?? 1,
    evalExit: evalStatusLabel(report),
    generationExit: report.generationResult?.exitCode ?? "skipped",
    kind: "mod_learning_candidate_manifest",
    passed: report.passed,
    runDir: report.runDir,
    score: reportScore(report),
    version: 1,
  };
}

async function writeCandidateManifest(
  report: ModLearningReport,
): Promise<void> {
  await writeJsonArtifact(
    candidateManifestPath(report.runDir),
    await buildCandidateManifest(report),
  );
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
  historyManifestPath?: string;
  proposerGuidePath?: string;
  selectedCandidateIndex?: number;
  spec: ModLearningSpec;
}): string {
  const lines = [
    `# Mod learning history: ${params.spec.name}`,
    "",
    `- Attempts: ${params.attempts.length}`,
    `- Selected candidate: ${params.selectedCandidateIndex ?? "not selected yet"}`,
    ...(params.historyManifestPath
      ? [`- Machine-readable history: ${params.historyManifestPath}`]
      : []),
    ...(params.proposerGuidePath
      ? [`- Proposer filesystem guide: ${params.proposerGuidePath}`]
      : []),
    "",
  ];

  for (const attempt of params.attempts) {
    lines.push(
      `## Candidate ${attempt.candidateIndex}: ${attempt.passed ? "PASS" : "FAIL"}`,
      "",
      `- Score: ${attempt.score}`,
      `- Directory: ${attempt.runDir}`,
      `- Manifest: ${candidateManifestPath(attempt.runDir)}`,
      `- Candidate: ${attempt.candidatePath}`,
      `- Report: ${attempt.reportPath}`,
      `- Generation exit: ${attempt.generationExit}`,
      `- Eval exit: ${attempt.evalExit}`,
    );
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

function buildHistoryManifest(params: {
  attempts: ModLearningAttemptSummary[];
  historyManifestPath: string;
  historyPath: string;
  proposerGuidePath: string;
  runDir: string;
  selectedCandidateIndex?: number;
  spec: ModLearningSpec;
}): ModLearningHistoryManifest {
  return {
    attemptCount: params.attempts.length,
    attempts: params.attempts.map((attempt) => ({
      ...attempt,
      manifestPath: candidateManifestPath(attempt.runDir),
      reportJsonPath: path.join(attempt.runDir, "report.json"),
    })),
    historyMarkdownPath: params.historyPath,
    historyManifestPath: params.historyManifestPath,
    kind: "mod_learning_history_manifest",
    proposerGuidePath: params.proposerGuidePath,
    runDir: params.runDir,
    ...(params.selectedCandidateIndex !== undefined
      ? { selectedCandidateIndex: params.selectedCandidateIndex }
      : {}),
    spec: {
      name: params.spec.name,
      ...(params.spec.slug ? { slug: params.spec.slug } : {}),
      ...(params.spec.targetModName
        ? { targetModName: params.spec.targetModName }
        : {}),
    },
    version: 1,
  };
}

function renderProposerGuide(params: {
  attempts: ModLearningAttemptSummary[];
  historyManifestPath: string;
  historyPath: string;
  runDir: string;
  selectedCandidateIndex?: number;
  spec: ModLearningSpec;
}): string {
  const lines = [
    `# Mod learning proposer guide: ${params.spec.name}`,
    "",
    "This run directory is meant to be read by the next candidate proposer. Treat all prior candidate artifacts as read-only diagnostic context.",
    "",
    "## Start here",
    "",
    `1. Machine-readable history manifest: ${params.historyManifestPath}`,
    `2. Human summary: ${params.historyPath}`,
    "3. Per-candidate manifests: `<candidate run dir>/manifest.json`",
    "",
    "## How to inspect prior attempts",
    "",
    "Use normal filesystem tools (`cat`, `rg`, `ls`, `diff`) to inspect only the artifacts you need. Good first reads are:",
    "",
    "- `manifest.json` for each prior candidate: paths to source, report, generation logs, eval logs, and assertion results.",
    "- `report.md` / `report.json`: pass/fail, score, failed markers, failed assertions.",
    "- `mods/<candidate>.ts`: the candidate source to avoid repeating implementation mistakes.",
    "- `generation-prompt.md`, `generation.stdout`, `generation.stderr`: how the candidate was produced.",
    "- `eval/**/assertions.result.json`: deterministic mod API failures.",
    "- `eval/**/eval.stdout` and `eval/**/eval.stderr`: full headless traces for prompt scenarios.",
    "",
    "Prefer diagnosing a concrete failed scenario or assertion before writing the next candidate. Do not rely only on aggregate score.",
    "",
    "## Prior candidates",
    "",
  ];

  if (params.attempts.length === 0) {
    lines.push("No prior candidates yet.", "");
  } else {
    for (const attempt of params.attempts) {
      lines.push(
        `- Candidate ${attempt.candidateIndex}: ${attempt.passed ? "PASS" : "FAIL"}, score ${attempt.score}`,
        `  - dir: ${attempt.runDir}`,
        `  - manifest: ${candidateManifestPath(attempt.runDir)}`,
        `  - source: ${attempt.candidatePath}`,
        `  - report: ${attempt.reportPath}`,
      );
    }
    lines.push("");
  }

  lines.push(
    `Selected candidate: ${params.selectedCandidateIndex ?? "not selected yet"}`,
    `Run directory: ${params.runDir}`,
    "",
  );

  return `${lines.join("\n")}\n`;
}

async function writeHistoryArtifacts(params: {
  attempts: ModLearningAttemptSummary[];
  historyManifestPath: string;
  historyPath: string;
  proposerGuidePath: string;
  runDir: string;
  selectedCandidateIndex?: number;
  spec: ModLearningSpec;
}): Promise<void> {
  await writeFile(
    params.historyPath,
    renderHistoryIndex({
      attempts: params.attempts,
      historyManifestPath: params.historyManifestPath,
      proposerGuidePath: params.proposerGuidePath,
      selectedCandidateIndex: params.selectedCandidateIndex,
      spec: params.spec,
    }),
    "utf8",
  );
  await writeJsonArtifact(
    params.historyManifestPath,
    buildHistoryManifest(params),
  );
  await writeFile(
    params.proposerGuidePath,
    renderProposerGuide(params),
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

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      options.onStdout?.(chunk.toString("utf8"));
    });
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
  scenarioLimit?: number;
  spec: ModLearningSpec;
}): ModLearningEvaluator {
  const hasConfiguredScenarios =
    (params.spec.evaluation.scenarios?.length ?? 0) > 0;
  const artifactsDir = hasConfiguredScenarios
    ? path.join(params.runDir, "eval")
    : path.join(params.runDir, "eval-memory");
  const scenarios = limitedEvaluationScenarios(
    params.spec.evaluation,
    params.scenarioLimit,
  );

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

        let scenarioEvaluation: ModLearningEvaluationResult = {
          assertionChecks: [],
          forbiddenResultMarkers: [],
          forbiddenTraceMarkers: [],
          passed: true,
          requiredResultMarkers: [],
          requiredTraceMarkers: [],
          resultText: "",
        };
        let scenarioEvalExit: number | null = null;
        let scenarioTimedOut = false;

        if (scenarioSpec.assertions?.length) {
          const assertionEvaluation = await evaluateModLearningAssertions({
            assertions: scenarioSpec.assertions,
            cacheDirectory: path.join(scenarioDir, "mod-cache"),
            candidateDir: context.candidate.dir,
            repoRoot: context.repoRoot,
          });
          await writeJsonArtifact(
            hasConfiguredScenarios
              ? path.join(scenarioDir, "assertions.result.json")
              : path.join(context.runDir, "assertions.result.json"),
            assertionEvaluation,
          );
          scenarioEvaluation = mergeEvaluationResults(
            scenarioEvaluation,
            assertionEvaluation,
          );
        }

        if (scenarioSpec.prompt?.trim()) {
          const outputFormat = scenarioSpec.outputFormat ?? "stream-json";
          const evalPrompt = renderEvaluationPrompt(
            scenarioSpec.prompt,
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
              onStdout: createHeadlessConversationObserver(
                `eval scenario ${scenarioIndex + 1}/${scenarios.length} ${scenario.name}`,
                (activeConversation) => {
                  const partialEvaluation = hasConfiguredScenarios
                    ? aggregateScenarioEvaluations(scenarioResults)
                    : scenarioEvaluation;
                  context.onScenarioProgress?.({
                    activeConversation,
                    evaluation: partialEvaluation,
                    scenarioCount: scenarios.length,
                    scenarioIndex: scenarioIndex + 1,
                    scenarioName: scenario.name,
                    score: markerScore(partialEvaluation),
                  });
                },
              ),
              timeoutMs: scenarioSpec.timeoutMs ?? 15 * 60 * 1000,
            },
          );
          scenarioEvalExit = scenarioEvalResult.exitCode;
          scenarioTimedOut = scenarioEvalResult.timedOut;
          commandResult ??= scenarioEvalResult;
          await writeCommandArtifacts(
            hasConfiguredScenarios
              ? path.join(scenarioDir, "eval")
              : path.join(context.runDir, "eval"),
            context.cliCommand,
            evalArgs,
            scenarioEvalResult,
          );
          const markerEvaluation = evaluateModLearningRun({
            exitCode: scenarioEvalResult.exitCode,
            outputFormat,
            spec: scenarioSpec,
            stderr: scenarioEvalResult.stderr,
            stdout: scenarioEvalResult.stdout,
            timedOut: scenarioEvalResult.timedOut,
          });
          scenarioEvaluation = mergeEvaluationResults(
            scenarioEvaluation,
            markerEvaluation,
          );
        }

        scenarioResults.push({
          ...scenarioEvaluation,
          evalExit: scenarioEvalExit,
          evalMemoryDir: scenarioMemoryDir,
          name: scenario.name,
          timedOut: scenarioTimedOut,
        });
        const partialEvaluation = hasConfiguredScenarios
          ? aggregateScenarioEvaluations(scenarioResults)
          : (scenarioResults[0] ?? scenarioEvaluation);
        context.onScenarioProgress?.({
          evaluation: partialEvaluation,
          scenarioCount: scenarios.length,
          scenarioIndex: scenarioIndex + 1,
          scenarioName: scenario.name,
          score: markerScore(partialEvaluation),
        });
      }

      const evaluation = hasConfiguredScenarios
        ? aggregateScenarioEvaluations(scenarioResults)
        : (scenarioResults[0] ?? {
            assertionChecks: [],
            forbiddenResultMarkers: [],
            forbiddenTraceMarkers: [],
            passed: false,
            requiredResultMarkers: [],
            requiredTraceMarkers: [],
            resultText: "",
          });
      return {
        artifactsDir,
        commandResult,
        evaluation,
        score: markerScore(evaluation),
      };
    },
    label: hasConfiguredScenarios ? "scenario suite" : "scenario",
  };
}

function createModLearningEvaluator(params: {
  options: RunModLearningOptions;
  runDir: string;
}): ModLearningEvaluator {
  return createScenarioSuiteEvaluator({
    runDir: params.runDir,
    scenarioLimit: params.options.scenarioLimit,
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

function renderAssertionSection(checks: ModLearningAssertionCheck[]): string[] {
  if (checks.length === 0) return ["- Assertion checks: none configured"];
  return [
    "- Assertion checks:",
    ...checks.map((check) =>
      [
        `  - ${check.passed ? "✅" : "❌"} ${check.label}: ${check.message}`,
        check.details ? `    - Details: ${JSON.stringify(check.details)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ];
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface ModLearningProgressEvent {
  progress: ModLearningProgress;
  timestamp: string;
}

function progressHtmlPath(runDir: string): string {
  return path.join(runDir, "progress.html");
}

function progressJsonlPath(runDir: string): string {
  return path.join(runDir, "progress.jsonl");
}

function conversationUrl(
  conversation: ModLearningHeadlessConversation,
): string | null {
  if (!conversation.agentId) return null;
  return `https://app.letta.com/chat/${encodeURIComponent(conversation.agentId)}?conversation=${encodeURIComponent(conversation.conversationId)}`;
}

function progressScore(progress: ModLearningProgress): string {
  if (progress.score === undefined) return "";
  return `${progress.score}${progress.maxScore !== undefined ? `/${progress.maxScore}` : ""}`;
}

function renderProgressConversation(
  conversation: ModLearningHeadlessConversation | undefined,
): string {
  if (!conversation) return "";
  const url = conversationUrl(conversation);
  const text = `${conversation.label}: ${conversation.conversationId}${conversation.agentId ? ` · ${conversation.agentId}` : ""}`;
  return url
    ? `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`
    : escapeHtml(text);
}

function renderLiveProgressHtml(params: {
  events: ModLearningProgressEvent[];
  jsonlPath: string;
  runDir: string;
  spec: ModLearningSpec;
}): string {
  const latest = params.events.at(-1)?.progress;
  const rows = params.events
    .map(({ progress, timestamp }) => {
      const candidate = progress.candidateIndex
        ? `${progress.candidateIndex}${progress.candidateCount ? `/${progress.candidateCount}` : ""}`
        : "";
      const status =
        progress.passed === undefined ? "" : progress.passed ? "PASS" : "FAIL";
      return `<tr><td>${escapeHtml(new Date(timestamp).toLocaleString())}</td><td>${escapeHtml(progress.phase)}</td><td>${escapeHtml(candidate)}</td><td>${escapeHtml(progress.message)}</td><td>${escapeHtml(progressScore(progress))}</td><td>${escapeHtml(status)}</td><td>${renderProgressConversation(progress.activeConversation)}</td><td><code>${escapeHtml(progress.candidateRunDir ?? progress.runDir)}</code></td></tr>`;
    })
    .join("\n");
  const conversations = new Map<string, ModLearningHeadlessConversation>();
  for (const event of params.events) {
    const conversation = event.progress.activeConversation;
    if (!conversation) continue;
    conversations.set(
      `${conversation.agentId ?? ""}:${conversation.conversationId}:${conversation.label}`,
      conversation,
    );
  }
  const conversationItems = [...conversations.values()]
    .map(
      (conversation) => `<li>${renderProgressConversation(conversation)}</li>`,
    )
    .join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="3" />
  <title>Live mod learning progress: ${escapeHtml(params.spec.name)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 28px; line-height: 1.45; }
    .hero { border: 1px solid #8884; border-radius: 16px; padding: 18px; max-width: 1100px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-top: 12px; }
    .card { border: 1px solid #8883; border-radius: 12px; padding: 12px; }
    table { border-collapse: collapse; width: 100%; margin-top: 18px; }
    th, td { border-bottom: 1px solid #8883; padding: 8px; text-align: left; vertical-align: top; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
    a { color: #7c3aed; }
  </style>
</head>
<body>
  <main class="hero">
    <h1>Live mod learning progress: ${escapeHtml(params.spec.name)}</h1>
    <p>This page auto-refreshes every 3 seconds while the learning run updates <code>progress.jsonl</code>.</p>
    <div class="grid">
      <div class="card"><strong>Latest phase</strong><br />${escapeHtml(latest?.phase ?? "waiting")}</div>
      <div class="card"><strong>Latest message</strong><br />${escapeHtml(latest?.message ?? "waiting for first event")}</div>
      <div class="card"><strong>Run directory</strong><br /><code>${escapeHtml(params.runDir)}</code></div>
      <div class="card"><strong>Progress log</strong><br /><code>${escapeHtml(params.jsonlPath)}</code></div>
    </div>
  </main>

  <h2>Agent / environment conversations</h2>
  ${conversationItems ? `<ul>${conversationItems}</ul>` : "<p>No headless agent conversation has been observed yet.</p>"}

  <h2>Timeline</h2>
  <table>
    <thead><tr><th>Time</th><th>Phase</th><th>Iter</th><th>Message</th><th>Score</th><th>Status</th><th>Agent/env run</th><th>Artifact dir</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>\n`;
}

function createModLearningProgressRecorder(params: {
  onProgress?: (progress: ModLearningProgress) => void;
  runDir: string;
  spec: ModLearningSpec;
}): {
  onProgress: (progress: ModLearningProgress) => void;
  progressHtmlPath: string;
  progressJsonlPath: string;
} {
  const htmlPath = progressHtmlPath(params.runDir);
  const jsonlPath = progressJsonlPath(params.runDir);
  const events: ModLearningProgressEvent[] = [];
  const writeHtml = () => {
    writeFileSync(
      htmlPath,
      renderLiveProgressHtml({
        events,
        jsonlPath,
        runDir: params.runDir,
        spec: params.spec,
      }),
      "utf8",
    );
  };
  writeHtml();
  return {
    onProgress: (progress) => {
      const event = { progress, timestamp: new Date().toISOString() };
      events.push(event);
      appendFileSync(jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
      writeHtml();
      params.onProgress?.(progress);
    },
    progressHtmlPath: htmlPath,
    progressJsonlPath: jsonlPath,
  };
}

function renderHtmlReport(report: ModLearningReport): string {
  const status = report.passed ? "PASS" : "FAIL";
  const score = reportScore(report);
  const maxScore = report.maxScore ?? Math.max(score, 1);
  const scorePct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const attempts = report.attempts ?? [];
  const scenarios = report.evaluation.scenarioResults ?? [];
  const attemptRows = attempts
    .map((attempt) => {
      const attemptMax = report.maxScore ?? Math.max(attempt.score, 1);
      const attemptPct =
        attemptMax > 0 ? Math.round((attempt.score / attemptMax) * 100) : 0;
      return `<tr><td>${attempt.candidateIndex}</td><td><span class="pill ${attempt.passed ? "pass" : "fail"}">${attempt.passed ? "PASS" : "FAIL"}</span></td><td>${attempt.score}</td><td><div class="bar"><span style="width:${attemptPct}%"></span></div></td><td><code>${escapeHtml(attempt.candidatePath)}</code></td><td><code>${escapeHtml(attempt.reportPath)}</code></td></tr>`;
    })
    .join("\n");
  const scenarioRows = scenarios
    .map(
      (scenario) =>
        `<tr><td>${escapeHtml(scenario.name)}</td><td><span class="pill ${scenario.passed ? "pass" : "fail"}">${scenario.passed ? "PASS" : "FAIL"}</span></td><td>${escapeHtml(scenario.evalExit ?? "not run")}</td><td><code>${escapeHtml(scenario.evalMemoryDir)}</code></td></tr>`,
    )
    .join("\n");
  const assertionItems = report.evaluation.assertionChecks
    .map(
      (check) =>
        `<li class="${check.passed ? "ok" : "bad"}"><strong>${check.passed ? "✓" : "✕"} ${escapeHtml(check.label)}</strong>: ${escapeHtml(check.message)}</li>`,
    )
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Mod learning report: ${escapeHtml(report.spec.name)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 32px; line-height: 1.45; }
    .hero { border: 1px solid #8884; border-radius: 16px; padding: 20px; max-width: 980px; }
    .pill { border-radius: 999px; padding: 2px 8px; font-size: 12px; font-weight: 700; }
    .pass { background: #16a34a22; color: #16a34a; }
    .fail { background: #dc262622; color: #dc2626; }
    .bar { width: 180px; height: 10px; border-radius: 999px; background: #8883; overflow: hidden; }
    .bar span { display: block; height: 100%; background: #7c3aed; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border-bottom: 1px solid #8883; padding: 8px; text-align: left; vertical-align: top; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
    pre { white-space: pre-wrap; border: 1px solid #8883; border-radius: 12px; padding: 12px; overflow: auto; }
    .ok { color: #16a34a; } .bad { color: #dc2626; }
  </style>
</head>
<body>
  <main class="hero">
    <h1>Mod learning report: ${escapeHtml(report.spec.name)}</h1>
    <p><span class="pill ${report.passed ? "pass" : "fail"}">${status}</span></p>
    <p><strong>Score:</strong> ${score}${report.maxScore !== undefined ? `/${report.maxScore}` : ""} (${scorePct}%)</p>
    <div class="bar"><span style="width:${scorePct}%"></span></div>
    <p><strong>Run directory:</strong> <code>${escapeHtml(report.runDir)}</code></p>
    ${report.progressHtmlPath ? `<p><strong>Live progress:</strong> <code>${escapeHtml(report.progressHtmlPath)}</code></p>` : ""}
    ${report.progressJsonlPath ? `<p><strong>Progress log:</strong> <code>${escapeHtml(report.progressJsonlPath)}</code></p>` : ""}
    <p><strong>Candidate:</strong> <code>${escapeHtml(report.candidatePath)}</code></p>
    <p><strong>Markdown report:</strong> <code>${escapeHtml(report.reportPath)}</code></p>
  </main>

  ${attempts.length > 0 ? `<h2>Optimization attempts</h2><table><thead><tr><th>#</th><th>Status</th><th>Score</th><th>Viz</th><th>Candidate</th><th>Report</th></tr></thead><tbody>${attemptRows}</tbody></table>` : ""}
  ${scenarios.length > 0 ? `<h2>Evaluation scenarios</h2><table><thead><tr><th>Scenario</th><th>Status</th><th>Eval exit</th><th>Memory dir</th></tr></thead><tbody>${scenarioRows}</tbody></table>` : ""}
  <h2>Assertions</h2>
  <ul>${assertionItems || "<li>No assertion checks configured.</li>"}</ul>
  <h2>Extracted result</h2>
  <pre>${escapeHtml(report.evaluation.resultText || "(empty)")}</pre>
</body>
</html>\n`;
}

function renderMarkdownReport(report: ModLearningReport): string {
  const status = report.passed ? "PASS" : "FAIL";
  const lines = [
    `# Mod learning report: ${report.spec.name}`,
    "",
    `- Status: ${status}`,
    `- Evaluator: scenario-suite`,
    `- Run directory: ${report.runDir}`,
    ...(report.progressHtmlPath
      ? [`- Live progress: ${report.progressHtmlPath}`]
      : []),
    ...(report.progressJsonlPath
      ? [`- Progress log: ${report.progressJsonlPath}`]
      : []),
    ...(report.candidateCount && report.candidateCount > 1
      ? [
          `- Candidate attempts: ${report.attempts?.length ?? report.candidateCount}/${report.candidateCount}${report.stoppedEarlyAt ? ` (stopped early: ${report.stoppedEarlyReason ?? "complete"})` : ""}`,
          `- Selected candidate: ${report.selectedCandidateIndex ?? report.candidateIndex}${report.stoppedEarlyAt ? " (perfect score)" : ""}`,
        ]
      : []),
    `- Candidate: ${report.candidatePath}`,
    `- Eval memory dir: ${report.evalMemoryDir}`,
    `- Generation exit: ${report.generationResult?.exitCode ?? "skipped"}`,
    evalReportLine(report),
    `- Marker score: ${reportScore(report)}${report.maxScore !== undefined ? `/${report.maxScore}` : ""}`,
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
    "## Evaluation checks",
    ...renderAssertionSection(report.evaluation.assertionChecks),
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
  historyManifestPath?: string;
  historyPath?: string;
  options: RunModLearningOptions;
  previousAttempts: ModLearningAttemptSummary[];
  previousAttemptDirs: string[];
  proposerGuidePath?: string;
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
  const maxScore = maxEvaluationScore(
    options.spec.evaluation,
    options.scenarioLimit,
  );

  const emitProgress = (
    phase: ModLearningProgressPhase,
    message: string,
    extra: Partial<ModLearningProgress> = {},
  ) => {
    options.onProgress?.({
      ...(params.previousAttempts.length > 0
        ? { attempts: [...params.previousAttempts] }
        : {}),
      candidateCount: params.candidateCount,
      candidateIndex: params.candidateIndex,
      candidatePath,
      candidateRunDir: runDir,
      maxScore,
      message,
      phase,
      runDir: topLevelRunDir,
      ...extra,
    });
  };

  emitProgress(
    "preparing",
    params.candidateCount > 1
      ? `Preparing optimization iteration ${params.candidateIndex}/${params.candidateCount}`
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
    const generationMessage =
      params.candidateCount > 1
        ? `Generating optimization iteration ${params.candidateIndex}/${params.candidateCount}`
        : "Generating candidate mod";
    emitProgress("generating", generationMessage);
    const promptHistory: ModLearningPromptHistory = {
      candidateCount: params.candidateCount,
      candidateIndex: params.candidateIndex,
      previousAttemptDirs: params.previousAttemptDirs,
    };
    if (params.historyPath) promptHistory.historyPath = params.historyPath;
    if (params.historyManifestPath)
      promptHistory.historyManifestPath = params.historyManifestPath;
    if (params.proposerGuidePath)
      promptHistory.proposerGuidePath = params.proposerGuidePath;
    const generationPrompt = buildModLearningPrompt(
      specForScenarioLimit(options.spec, options.scenarioLimit),
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
        personality: "meta",
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
      onStdout: createHeadlessConversationObserver(
        `generation iteration ${params.candidateIndex}`,
        (activeConversation) => {
          emitProgress("generating", generationMessage, {
            activeConversation,
          });
        },
      ),
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
  let score = 0;
  let evaluation: ModLearningEvaluationResult = {
    assertionChecks: [],
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
          ? `Evaluating optimization iteration ${params.candidateIndex}/${params.candidateCount}`
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
      onScenarioProgress: (progress) => {
        emitProgress(
          "evaluating",
          `${
            params.candidateCount > 1
              ? `Evaluating optimization iteration ${params.candidateIndex}/${params.candidateCount}`
              : "Evaluating candidate mod"
          }: scenario ${progress.scenarioIndex}/${progress.scenarioCount} ${progress.scenarioName}`,
          {
            ...(progress.activeConversation
              ? { activeConversation: progress.activeConversation }
              : {}),
            passed: progress.evaluation.passed,
            score: progress.score,
          },
        );
      },
      repoRoot,
      runDir,
      runner: params.runner,
    });
    evalResult = evaluatorResult.commandResult;
    evaluation = evaluatorResult.evaluation;
    score = evaluatorResult.score;
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
  const reportHtmlPath = path.join(runDir, "report.html");
  emitProgress("writing-report", "Writing mod learning report");
  const report: ModLearningReport = {
    candidateCount: params.candidateCount,
    candidateIndex: params.candidateIndex,
    candidatePath,
    evalMemoryDir,
    evalResult,
    evaluation,
    generationResult,
    maxScore,
    passed,
    promotedToPath,
    progressHtmlPath: progressHtmlPath(topLevelRunDir),
    progressJsonlPath: progressJsonlPath(topLevelRunDir),
    reportHtmlPath,
    reportPath,
    runDir,
    score,
    spec: options.spec,
  };
  await writeJsonArtifact(path.join(runDir, "report.json"), report);
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(reportHtmlPath, renderHtmlReport(report), "utf8");
  await writeCandidateManifest(report);
  emitProgress(
    "done",
    params.candidateCount > 1
      ? `Optimization iteration ${params.candidateIndex}/${params.candidateCount} complete`
      : "mod optimization complete",
    {
      attempts: [...params.previousAttempts, summarizeAttempt(report)],
      passed: report.passed,
      score,
    },
  );
  return report;
}

export async function runModLearning(
  options: RunModLearningOptions,
): Promise<ModLearningReport> {
  const candidateCount = normalizeCandidateCount(options.candidateCount);
  const scenarioLimit = normalizeScenarioLimit(options.scenarioLimit);
  let normalizedOptions: RunModLearningOptions = {
    ...options,
    scenarioLimit,
  };
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
        normalizedOptions.spec,
        normalizedOptions.outputBaseDir ??
          path.join(".letta", "mod-learning-runs"),
      ),
  );
  const candidateFileName = normalizeCandidateFileName(
    normalizedOptions.spec,
    normalizedOptions.candidateFileName,
  );
  const runner = normalizedOptions.commandRunner ?? defaultCommandRunner;
  const cliCommand = normalizedOptions.cliCommand ?? "bun";
  const cliArgsPrefix = normalizedOptions.cliArgsPrefix ?? ["run", "dev"];
  const baseEnv = normalizedOptions.env ?? process.env;

  await mkdir(runDir, { recursive: true });
  const progressRecorder = createModLearningProgressRecorder({
    onProgress: normalizedOptions.onProgress,
    runDir,
    spec: normalizedOptions.spec,
  });
  normalizedOptions = {
    ...normalizedOptions,
    onProgress: progressRecorder.onProgress,
  };
  await writeJsonArtifact(
    path.join(runDir, "env.snapshot.json"),
    normalizedOptions.spec,
  );

  if (candidateCount === 1) {
    const report = await runModLearningCandidate({
      baseEnv,
      candidateCount,
      candidateFileName,
      candidateIndex: 1,
      cliArgsPrefix,
      cliCommand,
      options: normalizedOptions,
      previousAttempts: [],
      previousAttemptDirs: [],
      repoRoot,
      runner,
      runDir,
      topLevelRunDir: runDir,
    });
    await writeHistoryArtifacts({
      attempts: [summarizeAttempt(report)],
      historyManifestPath: path.join(runDir, "history.json"),
      historyPath: path.join(runDir, "history.md"),
      proposerGuidePath: path.join(runDir, "proposer-guide.md"),
      runDir,
      selectedCandidateIndex: report.candidateIndex ?? 1,
      spec: normalizedOptions.spec,
    });
    return report;
  }

  const historyPath = path.join(runDir, "history.md");
  const historyManifestPath = path.join(runDir, "history.json");
  const proposerGuidePath = path.join(runDir, "proposer-guide.md");
  const attempts: ModLearningAttemptSummary[] = [];
  const reports: ModLearningReport[] = [];
  let stoppedEarlyAt: number | undefined;
  let stoppedEarlyReason: string | undefined;
  await writeHistoryArtifacts({
    attempts,
    historyManifestPath,
    historyPath,
    proposerGuidePath,
    runDir,
    spec: normalizedOptions.spec,
  });

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
      historyManifestPath,
      historyPath,
      options: { ...normalizedOptions, promoteToPath: undefined },
      previousAttempts: attempts,
      previousAttemptDirs: reports.map((attempt) => attempt.runDir),
      proposerGuidePath,
      repoRoot,
      runner,
      runDir: candidateRunDir,
      topLevelRunDir: runDir,
    });
    reports.push(report);
    attempts.push(summarizeAttempt(report));
    await writeHistoryArtifacts({
      attempts,
      historyManifestPath,
      historyPath,
      proposerGuidePath,
      runDir,
      spec: normalizedOptions.spec,
    });
    normalizedOptions.onProgress?.({
      attempts: [...attempts],
      candidateCount,
      candidateIndex,
      candidatePath: report.candidatePath,
      candidateRunDir: report.runDir,
      maxScore: report.maxScore,
      message: `Optimization iteration ${candidateIndex}/${candidateCount} complete`,
      passed: report.passed,
      phase: "evaluating",
      runDir,
      score: reportScore(report),
    });
    if (isPerfectReport(report)) {
      stoppedEarlyAt = candidateIndex;
      stoppedEarlyReason = "perfect score";
      break;
    }
  }

  const selectedReport = selectBestReport(reports);
  const selectedCandidateIndex = selectedReport.candidateIndex ?? 1;
  let promotedToPath: string | null = null;
  if (selectedReport.passed && normalizedOptions.promoteToPath) {
    normalizedOptions.onProgress?.({
      attempts,
      candidateCount,
      candidateIndex: selectedCandidateIndex,
      candidatePath: selectedReport.candidatePath,
      candidateRunDir: selectedReport.runDir,
      maxScore: selectedReport.maxScore,
      message: "Promoting selected candidate mod",
      phase: "promoting",
      runDir,
      score: selectedReport.score ?? markerScore(selectedReport.evaluation),
      selectedCandidateIndex,
    });
    promotedToPath = path.resolve(repoRoot, normalizedOptions.promoteToPath);
    await mkdir(path.dirname(promotedToPath), { recursive: true });
    await copyFile(selectedReport.candidatePath, promotedToPath);
  }

  const reportPath = path.join(runDir, "report.md");
  const reportHtmlPath = path.join(runDir, "report.html");
  const report: ModLearningReport = {
    ...selectedReport,
    attempts,
    candidateCount,
    promotedToPath,
    progressHtmlPath: progressRecorder.progressHtmlPath,
    progressJsonlPath: progressRecorder.progressJsonlPath,
    reportHtmlPath,
    reportPath,
    runDir,
    selectedCandidateIndex,
    ...(stoppedEarlyAt ? { stoppedEarlyAt } : {}),
    ...(stoppedEarlyReason ? { stoppedEarlyReason } : {}),
  };
  normalizedOptions.onProgress?.({
    candidateCount,
    candidateIndex: selectedCandidateIndex,
    candidatePath: report.candidatePath,
    candidateRunDir: selectedReport.runDir,
    attempts,
    maxScore: report.maxScore,
    message: "Writing mod learning summary report",
    phase: "writing-report",
    runDir,
    score: reportScore(report),
    selectedCandidateIndex,
  });
  await writeHistoryArtifacts({
    attempts,
    historyManifestPath,
    historyPath,
    proposerGuidePath,
    runDir,
    selectedCandidateIndex,
    spec: normalizedOptions.spec,
  });
  await writeJsonArtifact(path.join(runDir, "report.json"), report);
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  await writeFile(reportHtmlPath, renderHtmlReport(report), "utf8");
  normalizedOptions.onProgress?.({
    candidateCount,
    candidateIndex: selectedCandidateIndex,
    candidatePath: report.candidatePath,
    candidateRunDir: selectedReport.runDir,
    attempts,
    maxScore: report.maxScore,
    message: "mod optimization complete",
    passed: report.passed,
    phase: "done",
    runDir,
    score: reportScore(report),
    selectedCandidateIndex,
  });
  return report;
}

export async function readModLearningEnv(
  envPath: string,
): Promise<ModLearningSpec> {
  return JSON.parse(await readFile(envPath, "utf8")) as ModLearningSpec;
}
