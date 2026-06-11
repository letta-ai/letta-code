import path from "node:path";
import memoryCitationsEnvJson from "@/../docs/examples/mods/learning/memory-citations.env.json";
import type { AppCommandRunner } from "@/cli/app/types";
import type { CommandHandle } from "@/cli/commands/runner";
import { TERMINAL_TITLE_SPINNER_FRAMES } from "@/cli/helpers/window-title-config";
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
const DEFAULT_OPTIMIZATION_ITERATIONS = 10;
const MOD_OPTIMIZATION_SPINNER_INTERVAL_MS = 120;

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
    "",
    "Options:",
    "  --model <handle>              Model for generation and eval (default: auto)",
    "  --generation-model <handle>   Model for candidate generation",
    "  --eval-model <handle>         Model for headless eval",
    "  --backend <api|local>          Backend flag forwarded to headless runs",
    "  --candidate <path>            Evaluate an existing candidate instead of generating",
    "  --candidates <n>              Run N optimization iterations for one learned mod (default: 10)",
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

type ScorePoint = { score: number; step: number };

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

function formatScoreGraph(points: ScorePoint[]): string[] {
  if (points.length === 0) return [];

  const visiblePoints = points.slice(-MAX_SCORE_BARS);
  const maxScore = Math.max(...points.map((point) => point.score), 1);
  const scoreWidth = Math.max(
    1,
    ...visiblePoints.map((point) => String(point.score).length),
  );
  const stepWidth = Math.max(
    1,
    ...visiblePoints.map((point) => String(point.step).length),
  );
  const hiddenCount = points.length - visiblePoints.length;

  return [
    `Score graph: ${formatSparkline(points)}`,
    ...(hiddenCount > 0 ? [`  … ${hiddenCount} earlier step(s)`] : []),
    ...visiblePoints.map((point) => {
      const filled = Math.max(
        point.score > 0 ? 1 : 0,
        Math.round((point.score / maxScore) * SCORE_BAR_WIDTH),
      );
      const bar = filled > 0 ? "█".repeat(filled) : "·";
      return `  #${String(point.step).padStart(stepWidth, " ")} ${String(
        point.score,
      ).padStart(scoreWidth, " ")} │ ${bar}`;
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
): string[] {
  const timeline = formatOptimizationTimeline(currentStep, totalSteps);
  if (points.length > 0) {
    return [...(timeline ? [timeline] : []), ...formatScoreGraph(points)];
  }
  return [
    ...(timeline ? [timeline] : []),
    "Score graph: waiting for first evaluation…",
  ];
}

function progressScorePoints(progress: ModLearningProgress): ScorePoint[] {
  const scoreByStep = new Map<number, number>();
  for (const attempt of progress.attempts ?? []) {
    scoreByStep.set(attempt.candidateIndex, attempt.score);
  }
  if (progress.candidateIndex && progress.score !== undefined) {
    scoreByStep.set(progress.candidateIndex, progress.score);
  }
  return [...scoreByStep.entries()]
    .sort(([a], [b]) => a - b)
    .map(([step, score]) => ({ score, step }));
}

function reportScorePoints(report: ModLearningReport): ScorePoint[] {
  if (report.attempts?.length) {
    return report.attempts.map((attempt) => ({
      score: attempt.score,
      step: attempt.candidateIndex,
    }));
  }
  return [{ score: report.score ?? 0, step: report.candidateIndex ?? 1 }];
}

function formatProgress(
  learn: LearnCommand,
  progress: ModLearningProgress,
  cwd: string,
  spinnerFrame: string = TERMINAL_TITLE_SPINNER_FRAMES[0] ?? "⠋",
): string {
  const stepLine = progress.candidateIndex
    ? `Optimization iteration: ${progress.candidateIndex}${progress.candidateCount ? `/${progress.candidateCount}` : ""}`
    : null;
  const scorePoints = progressScorePoints(progress);
  const scoreHistoryLine = scorePoints.length
    ? `Score history: ${scorePoints
        .map((point) => `#${point.step} ${point.score}`)
        .join(" → ")}`
    : null;
  const bestScore = scorePoints.reduce<
    { score: number; step: number } | undefined
  >((best, point) => {
    if (!best || point.score > best.score) return point;
    return best;
  }, undefined);
  const bestScoreLine = bestScore
    ? `Best score: ${bestScore.score} at step ${bestScore.step}`
    : null;
  const currentScoreLine =
    progress.score === undefined ? null : `Current score: ${progress.score}`;
  const candidateLine =
    progress.candidateIndex &&
    progress.candidateCount &&
    progress.candidateCount > 1
      ? `Target mod: ${path.basename(progress.candidatePath)} (${displayPath(progress.candidatePath, cwd)})`
      : `Target mod: ${path.basename(progress.candidatePath)}`;
  return [
    `${spinnerFrame} Background mod optimization: ${learn.targetLabel}`,
    `Phase: ${progress.message}`,
    ...(stepLine ? [stepLine] : []),
    ...(currentScoreLine ? [currentScoreLine] : []),
    ...(bestScoreLine ? [bestScoreLine] : []),
    ...(scoreHistoryLine ? [scoreHistoryLine] : []),
    ...formatProgressScoreGraph(
      scorePoints,
      progress.candidateIndex,
      progress.candidateCount,
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
  const scoreHistory = scorePoints.length
    ? `Score history: ${scorePoints
        .map((point) => `#${point.step} ${point.score}`)
        .join(" → ")}`
    : null;
  const lines = [
    `Finished mod learning: ${report.spec.name}`,
    `Report: ${displayPath(report.reportPath, cwd)}`,
    ...(report.candidateCount && report.candidateCount > 1
      ? [
          `Selected iteration: ${report.selectedCandidateIndex ?? report.candidateIndex}/${report.candidateCount}`,
        ]
      : []),
    `Target mod: ${path.basename(report.candidatePath)} (${displayPath(report.candidatePath, cwd)})`,
    `Run directory: ${displayPath(report.runDir, cwd)}`,
    `Score: ${report.score ?? 0}`,
    ...(scoreHistory ? [scoreHistory] : []),
    ...formatScoreGraph(scorePoints),
    `Generation exit: ${report.generationResult?.exitCode ?? "skipped"}`,
    `Eval exit: ${report.evalResult?.exitCode ?? "not run"}`,
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
  let spinnerFrameIndex = 0;
  const renderProgress = (progress: ModLearningProgress) => {
    const spinnerFrame =
      TERMINAL_TITLE_SPINNER_FRAMES[spinnerFrameIndex] ??
      TERMINAL_TITLE_SPINNER_FRAMES[0] ??
      "⠋";
    command.update({
      output: formatProgress(learn, progress, ctx.cwd, spinnerFrame),
      phase: "running",
    });
  };
  const heartbeat = setInterval(() => {
    if (!lastProgress) return;
    spinnerFrameIndex =
      (spinnerFrameIndex + 1) % TERMINAL_TITLE_SPINNER_FRAMES.length;
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
