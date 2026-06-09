import path from "node:path";
import memoryCitationsSpecJson from "@/../docs/examples/mods/learning/memory-citations.spec.json";
import type { AppCommandRunner } from "@/cli/app/types";
import type { CommandHandle } from "@/cli/commands/runner";
import { parseExtensionCommandArgv as parseModCommandArgv } from "@/cli/extensions/command-runtime";
import type {
  CommandRunner,
  ModLearningProgress,
  ModLearningReport,
  ModLearningSpec,
} from "@/mods/learning-harness";
import { readModLearningSpec, runModLearning } from "@/mods/learning-harness";
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
  candidateFileName?: string;
  evalModel?: string;
  generationModel?: string;
  model?: string;
  out?: string;
  skipGeneration: boolean;
  specPath?: string;
  target: string;
};

type LearnCommand = {
  options: LearnCommandOptions;
  spec: ModLearningSpec | null;
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
  readSpec?: typeof readModLearningSpec;
  resolveLauncher?: () => LettaLauncher;
  runLearning?: RunModLearning;
};

export type HandleModsCommandResult =
  | { handled: false }
  | { done: Promise<void>; handled: true };

function cloneSpec(spec: ModLearningSpec): ModLearningSpec {
  return JSON.parse(JSON.stringify(spec)) as ModLearningSpec;
}

function builtInSpecForTarget(target: string): ModLearningSpec | null {
  if (target === DEFAULT_TARGET) {
    return cloneSpec(memoryCitationsSpecJson as ModLearningSpec);
  }
  return null;
}

function formatModsUsage(error?: string): string {
  const lines = [
    ...(error ? [`Error: ${error}`, ""] : []),
    "Usage:",
    "  /mods learn [memory-citations] [options]",
    "  /mods learn --spec <path> [options]",
    "",
    "Options:",
    "  --model <handle>              Model for generation and eval (default: auto)",
    "  --generation-model <handle>   Model for candidate generation",
    "  --eval-model <handle>         Model for headless eval",
    "  --backend <api|local>          Backend flag forwarded to headless runs",
    "  --candidate <path>            Evaluate an existing candidate instead of generating",
    "  --candidate-file-name <name>  Candidate filename in the eval mod dir",
    "  --out <dir>                   Artifact directory (default: .letta/mod-lab-runs/<target>-<timestamp>)",
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
          case "--spec":
            options.specPath = value;
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

  const spec = options.specPath ? null : builtInSpecForTarget(options.target);
  if (!spec && !options.specPath) {
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
      spec,
      targetLabel: options.specPath
        ? targetSet
          ? options.target
          : "custom spec"
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
  return [
    `Running Mod Lab: ${learn.targetLabel}`,
    `Phase: ${progress.message}`,
    `Run directory: ${displayPath(progress.runDir, cwd)}`,
    `Candidate: ${displayPath(progress.candidatePath, cwd)}`,
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
    `${status} Mod Lab: ${report.spec.name}`,
    `Report: ${displayPath(report.reportPath, cwd)}`,
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

async function resolveSpec(
  learn: LearnCommand,
  cwd: string,
  readSpec: typeof readModLearningSpec,
): Promise<ModLearningSpec> {
  if (learn.spec) return cloneSpec(learn.spec);
  const specPath = learn.options.specPath;
  if (!specPath) {
    throw new Error(
      `No spec configured for learning target: ${learn.options.target}`,
    );
  }
  return readSpec(path.resolve(cwd, specPath));
}

async function runLearnCommand(
  learn: LearnCommand,
  ctx: HandleModsCommandContext,
  command: CommandHandle,
): Promise<void> {
  const runLearningImpl = ctx.runLearning ?? runModLearning;
  const readSpecImpl = ctx.readSpec ?? readModLearningSpec;
  const launcher = (ctx.resolveLauncher ?? resolveCurrentLettaLauncher)();
  const env = await (ctx.getHeadlessEnv ?? defaultHeadlessEnv)();
  const spec = await resolveSpec(learn, ctx.cwd, readSpecImpl);
  const model = learn.options.model ?? DEFAULT_MODEL;
  const report = await runLearningImpl({
    backend: learn.options.backend,
    candidateFileName: learn.options.candidateFileName,
    candidateSourcePath: learn.options.candidate,
    cliArgsPrefix: launcher.args,
    cliCommand: launcher.command,
    commandRunner: ctx.learningCommandRunner,
    env,
    evalModel: learn.options.evalModel ?? model,
    generationModel: learn.options.generationModel ?? model,
    repoRoot: ctx.cwd,
    runDir: learn.options.out
      ? path.resolve(ctx.cwd, learn.options.out)
      : undefined,
    skipGeneration: learn.options.skipGeneration,
    spec,
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
    `Starting Mod Lab: ${parsed.learn.targetLabel}...`,
  );

  const done = runLearnCommand(parsed.learn, ctx, command).catch((error) => {
    command.fail(
      `Failed to run Mod Lab: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return { handled: true, done };
}
