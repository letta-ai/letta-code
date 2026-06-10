import path from "node:path";
import memoryCitationsEnvJson from "@/../docs/examples/mods/learning/memory-citations.env.json";
import type { AppCommandRunner } from "@/cli/app/types";
import type { CommandHandle } from "@/cli/commands/runner";
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
    "  --candidates <n>              Generate/evaluate N candidates, each seeing prior attempts",
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

function formatProgress(
  learn: LearnCommand,
  progress: ModLearningProgress,
  cwd: string,
): string {
  const candidateLine =
    progress.candidateIndex &&
    progress.candidateCount &&
    progress.candidateCount > 1
      ? `Candidate: ${progress.candidateIndex}/${progress.candidateCount} (${displayPath(progress.candidatePath, cwd)})`
      : `Candidate: ${displayPath(progress.candidatePath, cwd)}`;
  return [
    `Running mod learning: ${learn.targetLabel}`,
    `Phase: ${progress.message}`,
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
  const status = report.passed ? "PASS" : "FAIL";
  const lines = [
    `${status} mod learning: ${report.spec.name}`,
    `Report: ${displayPath(report.reportPath, cwd)}`,
    ...(report.candidateCount && report.candidateCount > 1
      ? [
          `Selected candidate: ${report.selectedCandidateIndex ?? report.candidateIndex}/${report.candidateCount}`,
        ]
      : []),
    `Candidate: ${displayPath(report.candidatePath, cwd)}`,
    `Run directory: ${displayPath(report.runDir, cwd)}`,
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
  const report = await runLearningImpl({
    backend: learn.options.backend,
    candidateCount: learn.options.candidateCount,
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
      command.update({
        output: formatProgress(learn, progress, ctx.cwd),
        phase: "running",
      });
    },
  });

  command.finish(formatModLearningSummary(report, ctx.cwd), report.passed);
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

  const command = ctx.commandRunner.start(
    trimmed,
    `Starting mod learning: ${parsed.learn.targetLabel}...`,
  );

  const done = runLearnCommand(parsed.learn, ctx, command).catch((error) => {
    command.fail(
      `Failed to run mod learning: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return { handled: true, done };
}
