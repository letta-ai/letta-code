import path from "node:path";
import memoryCitationsEnvJson from "@/../docs/examples/mods/learning/memory-citations.env.json";
import type { AppCommandRunner } from "@/cli/app/types";
import type { CommandHandle } from "@/cli/commands/runner";
import { BRAILLE_ANIMATIONS } from "@/cli/components/spinners/animations";
import { parseModCommandArgv } from "@/cli/mods/command-runtime";
import type {
  CommandRunner,
  ModLearningProgress,
  ModLearningReport,
  ModLearningSpec,
} from "@/mods/learning-harness";
import { readModLearningEnv, runModLearning } from "@/mods/learning-harness";
import { settingsManager } from "@/settings-manager";
import {
  resolveEntryScriptPath,
  resolveLettaInvocation,
} from "@/tools/impl/shell-env";

const DEFAULT_TARGET = "memory-citations";
const DEFAULT_MODEL = "auto";
const DEFAULT_OPTIMIZATION_ITERATIONS = 5;
const MOD_OPTIMIZATION_PULSE = BRAILLE_ANIMATIONS.pulse;
const MOD_OPTIMIZATION_RUNNING_LABELS = [
  "running",
  "running.",
  "running..",
  "running...",
];
const MOD_OPTIMIZATION_SPINNER_INTERVAL_MS = MOD_OPTIMIZATION_PULSE.intervalMs;

type RunModLearning = typeof runModLearning;

type LettaLauncher = {
  args: string[];
  command: string;
};

type LearnCommandOptions = {
  backend?: string;
  candidate?: string;
  candidateCount?: number;
  candidateFileName?: string;
  evalModel?: string;
  envPath?: string;
  generationModel?: string;
  model?: string;
  out?: string;
  scenarioLimit?: number;
  skipGeneration: boolean;
  target: string;
};

type LearnCommand = {
  options: LearnCommandOptions;
  env: ModLearningSpec | null;
  targetLabel: string;
};

export type ModsCommandParseResult =
  | { command: "learn"; learn: LearnCommand }
  | { command: "usage"; output: string; success: boolean };

export type ModsGenerateEnvCommand = { args: string };

export type HandleModsCommandContext = {
  commandRunner: Pick<AppCommandRunner, "start">;
  cwd: string;
  currentModelId?: string | null;
  getHeadlessEnv?: () => Promise<NodeJS.ProcessEnv>;
  learningCommandRunner?: CommandRunner;
  readEnv?: typeof readModLearningEnv;
  resolveLauncher?: () => LettaLauncher;
  runLearning?: RunModLearning;
};

export type HandleModsCommandResult =
  | { handled: false }
  | { done: Promise<void>; handled: true };

function cloneEnv(spec: ModLearningSpec): ModLearningSpec {
  return JSON.parse(JSON.stringify(spec)) as ModLearningSpec;
}

function builtInEnvForTarget(target: string): ModLearningSpec | null {
  if (target === DEFAULT_TARGET) {
    return cloneEnv(memoryCitationsEnvJson as ModLearningSpec);
  }
  return null;
}

function formatModsUsage(error?: string): string {
  const lines = [
    ...(error ? [`Error: ${error}`, ""] : []),
    "Usage:",
    "  /mods learn [memory-citations] [options]",
    "  /mods learn --env <path> [options]",
    "  /mods generate-env [request]",
    "",
    "Options:",
    "  --model <handle>              Model for generation and eval (default: auto)",
    "  --generation-model <handle>   Model for candidate generation",
    "  --eval-model <handle>         Model for headless eval",
    "  --backend <api|local>          Backend flag forwarded to headless runs",
    "  --candidate <path>            Evaluate an existing candidate instead of generating",
    "  --candidates <n>              Run N optimization iterations for one learned mod (default: 5)",
    "  --scenario-limit <n>          Evaluate only the first N scenarios (fast smoke testing)",
    "  --candidate-file-name <name>  Candidate filename in the eval mod dir",
    "  --out <dir>                   Artifact directory (default: .letta/mod-learning-runs/<target>-<timestamp>)",
    "  --skip-generation             Expect the candidate file to already exist in the run dir",
    "",
    "Built-in targets:",
    "  memory-citations",
    "",
    "The command writes artifacts and a candidate mod, but does not install it automatically.",
  ];
  return lines.join("\n");
}

function readOptionValue(
  argv: string[],
  index: number,
  optionName: string,
): { nextIndex: number; value: string } {
  const arg = argv[index] ?? "";
  const equalsPrefix = `${optionName}=`;
  if (arg.startsWith(equalsPrefix)) {
    return { nextIndex: index, value: arg.slice(equalsPrefix.length) };
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return { nextIndex: index + 1, value };
}

function resolveRequestedModel(
  requested: string | undefined,
  currentModelId: string | null | undefined,
): string | undefined {
  if (requested === "current") return currentModelId ?? DEFAULT_MODEL;
  return requested;
}

export function parseModsCommand(
  trimmed: string,
  currentModelId?: string | null,
): ModsCommandParseResult | null {
  if (trimmed !== "/mods" && !trimmed.startsWith("/mods ")) {
    return null;
  }

  const argv = parseModCommandArgv(trimmed.slice("/mods".length));
  const subcommand = argv[0];
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    return { command: "usage", output: formatModsUsage(), success: true };
  }
  if (subcommand !== "learn") {
    return {
      command: "usage",
      output: formatModsUsage(`Unknown /mods subcommand: ${subcommand}`),
      success: false,
    };
  }

  const options: LearnCommandOptions = {
    skipGeneration: false,
    target: DEFAULT_TARGET,
  };
  let targetSet = false;

  try {
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index] ?? "";
      if (arg === "help" || arg === "--help" || arg === "-h") {
        return {
          command: "usage",
          output: formatModsUsage(),
          success: true,
        };
      }

      if (arg === "--skip-generation") {
        options.skipGeneration = true;
        continue;
      }

      if (arg.startsWith("--")) {
        const optionName = arg.includes("=")
          ? arg.slice(0, arg.indexOf("="))
          : arg;
        const { nextIndex, value } = readOptionValue(argv, index, optionName);
        index = nextIndex;
        switch (optionName) {
          case "--backend":
            options.backend = value;
            break;
          case "--candidate":
            options.candidate = value;
            break;
          case "--candidates":
            options.candidateCount = Number(value);
            break;
          case "--candidate-file-name":
            options.candidateFileName = value;
            break;
          case "--eval-model":
            options.evalModel = resolveRequestedModel(value, currentModelId);
            break;
          case "--generation-model":
            options.generationModel = resolveRequestedModel(
              value,
              currentModelId,
            );
            break;
          case "--model":
            options.model = resolveRequestedModel(value, currentModelId);
            break;
          case "--out":
            options.out = value;
            break;
          case "--scenario-limit":
            options.scenarioLimit = Number(value);
            break;
          case "--env":
            options.envPath = value;
            break;
          default:
            throw new Error(`Unknown option: ${optionName}`);
        }
        continue;
      }

      if (targetSet) {
        throw new Error(`Unexpected argument: ${arg}`);
      }
      options.target = arg;
      targetSet = true;
    }
  } catch (error) {
    return {
      command: "usage",
      output: formatModsUsage(
        error instanceof Error ? error.message : String(error),
      ),
      success: false,
    };
  }

  const learningEnv = options.envPath
    ? null
    : builtInEnvForTarget(options.target);
  if (!learningEnv && !options.envPath) {
    return {
      command: "usage",
      output: formatModsUsage(`Unknown learning target: ${options.target}`),
      success: false,
    };
  }

  return {
    command: "learn",
    learn: {
      options,
      env: learningEnv,
      targetLabel: options.envPath
        ? targetSet
          ? options.target
          : "custom env"
        : options.target,
    },
  };
}

export function parseModsGenerateEnvCommand(
  trimmed: string,
): ModsGenerateEnvCommand | null {
  if (
    trimmed !== "/mods generate-env" &&
    !trimmed.startsWith("/mods generate-env ")
  ) {
    return null;
  }

  return {
    args: trimmed.slice("/mods generate-env".length).trim(),
  };
}

function displayPath(filePath: string, cwd: string): string {
  const relativePath = path.relative(cwd, filePath);
  if (
    relativePath &&
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  ) {
    return relativePath;
  }
  return filePath;
}

type ScorePoint = {
  completed: boolean;
  maxScore?: number;
  score: number;
  step: number;
};

const SPARKLINE_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const SCORE_BAR_WIDTH = 12;
const MAX_SCORE_BARS = 5;
const MAX_STEP_DOTS = 20;

function effectiveOptimizationIterations(
  options: LearnCommandOptions,
): number | undefined {
  if (options.candidateCount !== undefined) return options.candidateCount;
  if (options.candidate || options.skipGeneration) return undefined;
  return DEFAULT_OPTIMIZATION_ITERATIONS;
}

function formatSparkline(points: ScorePoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return "█";

  const scores = points.map((point) => point.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore;

  return scores
    .map((score) => {
      if (range === 0) return "▄";
      const index = Math.round(
        ((score - minScore) / range) * (SPARKLINE_BLOCKS.length - 1),
      );
      return SPARKLINE_BLOCKS[index] ?? "█";
    })
    .join("");
}

function formatScoreValue(score: number, maxScore: number | undefined): string {
  if (maxScore === undefined) return String(score);
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  return `${score}/${maxScore} (${percentage}%)`;
}

function formatScoreStatus(
  point: ScorePoint,
  runningLabel = "running",
): string {
  if (point.completed) return "done";
  return runningLabel;
}

function formatScoreGraph(
  points: ScorePoint[],
  runningLabel = "running",
): string[] {
  if (points.length === 0) return [];

  const allCompleted = points.every((point) => point.completed);
  const allSameScore = points.every(
    (point) => point.score === points[0]?.score,
  );
  if (points.length > 1 && allCompleted && allSameScore) {
    const first = points[0];
    return first
      ? [
          `Score graph: all ${points.length} completed iteration(s) scored ${formatScoreValue(first.score, first.maxScore)}`,
        ]
      : [];
  }

  const visiblePoints = points.slice(-MAX_SCORE_BARS);
  const maxScore = Math.max(...points.map((point) => point.score), 1);
  const scoreWidth = Math.max(
    1,
    ...visiblePoints.map(
      (point) => formatScoreValue(point.score, point.maxScore).length,
    ),
  );
  const statusWidth = "running...".length;
  const stepWidth = Math.max(
    1,
    ...visiblePoints.map((point) => String(point.step).length),
  );
  const hiddenCount = points.length - visiblePoints.length;

  return [
    `Score graph: ${formatSparkline(points)}`,
    ...(hiddenCount > 0 ? [`  … ${hiddenCount} earlier iteration(s)`] : []),
    ...visiblePoints.map((point) => {
      const filled = Math.max(
        point.score > 0 ? 1 : 0,
        Math.round((point.score / maxScore) * SCORE_BAR_WIDTH),
      );
      const bar = filled > 0 ? "█".repeat(filled) : "·";
      const status = formatScoreStatus(point, runningLabel).padEnd(
        statusWidth,
        " ",
      );
      return `  iter ${String(point.step).padStart(stepWidth, " ")} ${status} ${formatScoreValue(point.score, point.maxScore).padStart(scoreWidth, " ")} │ ${bar}`;
    }),
  ];
}

function formatOptimizationTimeline(
  currentStep: number | undefined,
  totalSteps: number | undefined,
): string | null {
  if (!currentStep && !totalSteps) return null;

  const total = Math.max(totalSteps ?? currentStep ?? 1, 1);
  const current = Math.min(Math.max(currentStep ?? 0, 0), total);
  const visibleDots = Math.min(total, MAX_STEP_DOTS);
  const filledDots = Math.min(
    visibleDots,
    Math.max(0, Math.ceil((current / total) * visibleDots)),
  );
  const dots = [
    "●".repeat(filledDots),
    "○".repeat(Math.max(visibleDots - filledDots, 0)),
  ].join("");
  return `Optimization progress: ${dots} ${current}/${total}`;
}

function formatProgressScoreGraph(
  points: ScorePoint[],
  currentStep: number | undefined,
  totalSteps: number | undefined,
  runningLabel = "running",
): string[] {
  const timeline = formatOptimizationTimeline(currentStep, totalSteps);
  if (points.length > 0) {
    return [
      ...(timeline ? [timeline] : []),
      ...formatScoreGraph(points, runningLabel),
    ];
  }
  return [
    ...(timeline ? [timeline] : []),
    "Score graph: waiting for first evaluation…",
  ];
}

function progressScorePoints(progress: ModLearningProgress): ScorePoint[] {
  const scoreByStep = new Map<number, ScorePoint>();
  for (const attempt of progress.attempts ?? []) {
    scoreByStep.set(attempt.candidateIndex, {
      completed: true,
      maxScore: attempt.maxScore ?? progress.maxScore,
      score: attempt.score,
      step: attempt.candidateIndex,
    });
  }
  if (progress.candidateIndex && progress.score !== undefined) {
    const completed = scoreByStep.has(progress.candidateIndex);
    scoreByStep.set(progress.candidateIndex, {
      completed,
      maxScore: progress.maxScore,
      score: progress.score,
      step: progress.candidateIndex,
    });
  }
  return [...scoreByStep.values()].sort((a, b) => a.step - b.step);
}

function reportScorePoints(report: ModLearningReport): ScorePoint[] {
  if (report.attempts?.length) {
    return report.attempts.map((attempt) => ({
      completed: true,
      maxScore: attempt.maxScore ?? report.maxScore,
      score: attempt.score,
      step: attempt.candidateIndex,
    }));
  }
  return [
    {
      completed: true,
      maxScore: report.maxScore,
      score: report.score ?? 0,
      step: report.candidateIndex ?? 1,
    },
  ];
}

function extractCommandFailureMessage(
  stderr: string | undefined,
): string | null {
  if (!stderr?.trim()) return null;
  const trimmed = stderr.trim();
  const jsonText = trimmed.startsWith("Error: ")
    ? trimmed.slice("Error: ".length)
    : trimmed;
  try {
    const parsed = JSON.parse(jsonText) as {
      error?: { error?: { detail?: unknown; message?: unknown } };
    };
    const message = parsed.error?.error?.detail ?? parsed.error?.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // Fall through to a concise first-line stderr summary.
  }
  return (
    trimmed
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? null
  );
}

function isAssertionOnlyReport(report: ModLearningReport): boolean {
  if (report.evalResult !== null) return false;
  if (report.generationResult && report.generationResult.exitCode !== 0) {
    return false;
  }
  const scenarioResults = report.evaluation.scenarioResults ?? [];
  if (scenarioResults.length > 0) {
    return scenarioResults.every(
      (scenario) =>
        scenario.evalExit === null && scenario.assertionChecks.length > 0,
    );
  }
  return report.evaluation.assertionChecks.length > 0;
}

function formatEvalSummaryLine(report: ModLearningReport): string {
  if (isAssertionOnlyReport(report)) return "Eval: assertions only";
  return `Eval exit: ${report.evalResult?.exitCode ?? "not run"}`;
}

function formatSelectionReason(report: ModLearningReport): string | null {
  if (report.stoppedEarlyAt) {
    return `${report.stoppedEarlyReason ?? "complete"}; stopped early`;
  }
  const score = report.score ?? 0;
  if (
    report.maxScore !== undefined &&
    report.maxScore > 0 &&
    score >= report.maxScore
  ) {
    return "earliest perfect score";
  }
  const attempts = report.attempts ?? [];
  const selectedIndex = report.selectedCandidateIndex ?? report.candidateIndex;
  const selectedAttempt = attempts.find(
    (attempt) => attempt.candidateIndex === selectedIndex,
  );
  if (!selectedAttempt) return null;
  const tiedBestCount = attempts.filter(
    (attempt) => attempt.score === selectedAttempt.score,
  ).length;
  return tiedBestCount > 1 ? "earliest best score" : "best score";
}

function formatScoreHistory(points: ScorePoint[]): string | null {
  if (points.length === 0) return null;
  const allCompleted = points.every((point) => point.completed);
  const allSameScore = points.every(
    (point) => point.score === points[0]?.score,
  );
  if (points.length > 1 && allCompleted && allSameScore) {
    const first = points[0];
    return first
      ? `Score history: all ${points.length} iteration(s) scored ${formatScoreValue(first.score, first.maxScore)}`
      : null;
  }
  return `Score history: ${points
    .map(
      (point) =>
        `iter ${point.step} done ${formatScoreValue(point.score, point.maxScore)}`,
    )
    .join(" → ")}`;
}

function formatElapsed(elapsedMs: number | undefined): string | null {
  if (elapsedMs === undefined) return null;
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${seconds}s elapsed`
    : `${seconds}s elapsed`;
}

function formatProgress(
  learn: LearnCommand,
  progress: ModLearningProgress,
  cwd: string,
  pulseFrame: string = MOD_OPTIMIZATION_PULSE.frames[0] ?? "⠀⠶⠀",
  runningLabel = "running",
  elapsedMs?: number,
): string {
  const stepLine = progress.candidateIndex
    ? `Optimization iteration: ${progress.candidateIndex}${progress.candidateCount ? `/${progress.candidateCount}` : ""}`
    : null;
  const scorePoints = progressScorePoints(progress);
  const scoreHistoryLine = scorePoints.length
    ? `Score history: ${scorePoints
        .map((point) => {
          const status = formatScoreStatus(point, runningLabel);
          return `iter ${point.step}${status ? ` ${status}` : ""} ${formatScoreValue(point.score, point.maxScore)}`;
        })
        .join(" → ")}`
    : null;
  const completedScorePoints = scorePoints.filter((point) => point.completed);
  const bestScore = completedScorePoints.reduce<
    { score: number; step: number } | undefined
  >((best, point) => {
    if (!best || point.score > best.score) return point;
    return best;
  }, undefined);
  const bestScoreLine = bestScore
    ? `Best completed score: ${formatScoreValue(bestScore.score, progress.maxScore)} at iteration ${bestScore.step}`
    : null;
  const currentScoreLine =
    progress.score === undefined
      ? null
      : `${scorePoints.find((point) => point.step === progress.candidateIndex)?.completed ? "Current score" : "Current running score"}: ${formatScoreValue(progress.score, progress.maxScore)}`;
  const candidateLine =
    progress.candidateIndex &&
    progress.candidateCount &&
    progress.candidateCount > 1
      ? `Target mod: ${path.basename(progress.candidatePath)} (${displayPath(progress.candidatePath, cwd)})`
      : `Target mod: ${path.basename(progress.candidatePath)}`;
  const elapsed = formatElapsed(elapsedMs);
  return [
    `${pulseFrame} Background mod optimization: ${learn.targetLabel}`,
    `Phase: ${progress.message}${elapsed ? ` · ${elapsed}` : ""}`,
    ...(stepLine ? [stepLine] : []),
    ...(currentScoreLine ? [currentScoreLine] : []),
    ...(bestScoreLine ? [bestScoreLine] : []),
    ...(scoreHistoryLine ? [scoreHistoryLine] : []),
    ...formatProgressScoreGraph(
      scorePoints,
      progress.candidateIndex,
      progress.candidateCount,
      runningLabel,
    ),
    `Run directory: ${displayPath(progress.runDir, cwd)}`,
    ...(progress.candidateRunDir && progress.candidateRunDir !== progress.runDir
      ? [`Attempt directory: ${displayPath(progress.candidateRunDir, cwd)}`]
      : []),
    candidateLine,
    "",
    "No mod will be installed automatically.",
  ].join("\n");
}

export function formatModLearningSummary(
  report: ModLearningReport,
  cwd: string,
): string {
  const scorePoints = reportScorePoints(report);
  const scoreHistory = formatScoreHistory(scorePoints);
  const selectionReason = formatSelectionReason(report);
  const lines = [
    `Finished mod learning: ${report.spec.name}`,
    `Report: ${displayPath(report.reportPath, cwd)}`,
    ...(report.candidateCount && report.candidateCount > 1
      ? [
          `Selected iteration: ${report.selectedCandidateIndex ?? report.candidateIndex}/${report.candidateCount}${selectionReason ? ` (${selectionReason})` : ""}`,
          ...(report.stoppedEarlyAt
            ? [
                `Stopped early: ${report.stoppedEarlyReason ?? "complete"} at iteration ${report.stoppedEarlyAt}`,
              ]
            : []),
        ]
      : []),
    `Target mod: ${path.basename(report.candidatePath)} (${displayPath(report.candidatePath, cwd)})`,
    `Run directory: ${displayPath(report.runDir, cwd)}`,
    `Score: ${formatScoreValue(report.score ?? 0, report.maxScore)}`,
    ...(scoreHistory ? [scoreHistory] : []),
    ...formatScoreGraph(scorePoints),
    `Generation exit: ${report.generationResult?.exitCode ?? "skipped"}`,
    ...(report.generationResult && report.generationResult.exitCode !== 0
      ? [
          `Generation failed: ${extractCommandFailureMessage(report.generationResult.stderr) ?? "see generation.stderr"}`,
        ]
      : []),
    formatEvalSummaryLine(report),
    ...(report.evalResult && report.evalResult.exitCode !== 0
      ? [
          `Eval failed: ${extractCommandFailureMessage(report.evalResult.stderr) ?? "see eval.stderr"}`,
        ]
      : []),
    "",
    report.passed
      ? "Review the candidate source before installing it. This command did not promote or load the mod."
      : "Open the report, generation stdout/stderr, and eval stdout/stderr in the run directory to debug the candidate.",
  ];
  return lines.join("\n");
}

export async function defaultHeadlessEnv(): Promise<NodeJS.ProcessEnv> {
  try {
    const settings = await settingsManager.getSettingsWithSecureTokens();
    return { ...(settings.env ?? {}), ...process.env };
  } catch {
    return { ...process.env };
  }
}

export function resolveCurrentLettaLauncher(): LettaLauncher {
  const invocation = resolveLettaInvocation(
    process.env,
    process.argv,
    process.execPath,
    process.cwd(),
  );
  if (invocation) return invocation;

  const currentScript = process.argv[1] || "";
  const resolvedCurrentScript = resolveEntryScriptPath(
    currentScript,
    process.cwd(),
  );

  if (currentScript.endsWith(".ts")) {
    return { command: process.execPath, args: [resolvedCurrentScript] };
  }
  if (currentScript.endsWith(".js") && process.platform === "win32") {
    return { command: process.execPath, args: [resolvedCurrentScript] };
  }
  if (currentScript.endsWith(".js")) {
    return { command: resolvedCurrentScript, args: [] };
  }

  return { command: "letta", args: [] };
}

async function resolveEnv(
  learn: LearnCommand,
  cwd: string,
  readEnv: typeof readModLearningEnv,
): Promise<ModLearningSpec> {
  if (learn.env) return cloneEnv(learn.env);
  const envPath = learn.options.envPath;
  if (!envPath) {
    throw new Error(
      `No env configured for learning target: ${learn.options.target}`,
    );
  }
  return readEnv(path.resolve(cwd, envPath));
}

async function runLearnCommand(
  learn: LearnCommand,
  ctx: HandleModsCommandContext,
  command: CommandHandle,
): Promise<void> {
  const runLearningImpl = ctx.runLearning ?? runModLearning;
  const readEnvImpl = ctx.readEnv ?? readModLearningEnv;
  const launcher = (ctx.resolveLauncher ?? resolveCurrentLettaLauncher)();
  const headlessEnv = await (ctx.getHeadlessEnv ?? defaultHeadlessEnv)();
  const learningEnv = await resolveEnv(learn, ctx.cwd, readEnvImpl);
  const model = learn.options.model ?? DEFAULT_MODEL;
  const optimizationIterations = effectiveOptimizationIterations(learn.options);
  let lastProgress: ModLearningProgress | null = null;
  let pulseFrameIndex = 0;
  let progressStartedAt = Date.now();
  let progressKey: string | null = null;
  const renderProgress = (progress: ModLearningProgress) => {
    const nextProgressKey = `${progress.phase}:${progress.candidateIndex ?? ""}:${progress.message}`;
    if (nextProgressKey !== progressKey) {
      progressKey = nextProgressKey;
      progressStartedAt = Date.now();
    }
    const pulseFrame =
      MOD_OPTIMIZATION_PULSE.frames[pulseFrameIndex] ??
      MOD_OPTIMIZATION_PULSE.frames[0] ??
      "⠀⠶⠀";
    const runningLabel =
      MOD_OPTIMIZATION_RUNNING_LABELS[
        pulseFrameIndex % MOD_OPTIMIZATION_RUNNING_LABELS.length
      ] ?? "running";
    command.update({
      output: formatProgress(
        learn,
        progress,
        ctx.cwd,
        pulseFrame,
        runningLabel,
        Date.now() - progressStartedAt,
      ),
      phase: "running",
    });
  };
  const heartbeat = setInterval(() => {
    if (!lastProgress) return;
    pulseFrameIndex =
      (pulseFrameIndex + 1) % MOD_OPTIMIZATION_PULSE.frames.length;
    renderProgress(lastProgress);
  }, MOD_OPTIMIZATION_SPINNER_INTERVAL_MS);

  try {
    const report = await runLearningImpl({
      backend: learn.options.backend,
      candidateCount: optimizationIterations,
      candidateFileName: learn.options.candidateFileName,
      candidateSourcePath: learn.options.candidate,
      cliArgsPrefix: launcher.args,
      cliCommand: launcher.command,
      commandRunner: ctx.learningCommandRunner,
      env: headlessEnv,
      evalModel: learn.options.evalModel ?? model,
      generationModel: learn.options.generationModel ?? model,
      repoRoot: ctx.cwd,
      runDir: learn.options.out
        ? path.resolve(ctx.cwd, learn.options.out)
        : undefined,
      scenarioLimit: learn.options.scenarioLimit,
      skipGeneration: learn.options.skipGeneration,
      spec: learningEnv,
      onProgress: (progress) => {
        lastProgress = progress;
        renderProgress(progress);
      },
    });

    command.finish(formatModLearningSummary(report, ctx.cwd), report.passed);
  } finally {
    clearInterval(heartbeat);
  }
}

export function handleModsCommand(
  trimmed: string,
  ctx: HandleModsCommandContext,
): HandleModsCommandResult {
  const parsed = parseModsCommand(trimmed, ctx.currentModelId);
  if (!parsed) return { handled: false };

  if (parsed.command === "usage") {
    const command = ctx.commandRunner.start(trimmed, parsed.output);
    command.finish(parsed.output, parsed.success);
    return { handled: true, done: Promise.resolve() };
  }

  const optimizationIterations = effectiveOptimizationIterations(
    parsed.learn.options,
  );
  const command = ctx.commandRunner.start(
    trimmed,
    `Starting background mod optimization: ${parsed.learn.targetLabel}${
      optimizationIterations ? ` (${optimizationIterations} iterations)` : ""
    }...`,
  );

  const done = runLearnCommand(parsed.learn, ctx, command).catch((error) => {
    command.fail(
      `Failed to run mod learning: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return { handled: true, done };
}
