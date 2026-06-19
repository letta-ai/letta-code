import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultHeadlessEnv,
  resolveCurrentLettaLauncher,
} from "@/cli/commands/mods";
import {
  defaultModLearningRunDirectory,
  type ModLearningProgress,
  type ModLearningReport,
  readModLearningEnv,
  runModLearning,
} from "@/mods/learning-harness";

const DEFAULT_OPTIMIZATION_STEPS = 10;

const BUILTIN_LEARNING_ENVS: Record<string, string> = {
  "memory-citations": "docs/examples/mods/learning/memory-citations.env.json",
  "uv-pip-install": "docs/examples/mods/learning/uv-pip-install.env.json",
};

type LearnSubcommandArgs = {
  backend?: string;
  candidate?: string;
  candidateCount?: number;
  candidateFileName?: string;
  evalModel?: string;
  foreground: boolean;
  generationModel?: string;
  help: boolean;
  promoteTo?: string;
  repoRoot: string;
  runDir?: string;
  scenarioLimit?: number;
  skipGeneration: boolean;
  target?: string;
};

function readOptionValue(
  argv: string[],
  index: number,
  optionName: string,
): { nextIndex: number; value: string } {
  const arg = argv[index] ?? "";
  const equalsPrefix = `${optionName}=`;
  if (arg.startsWith(equalsPrefix)) {
    const value = arg.slice(equalsPrefix.length);
    if (!value) throw new Error(`${optionName} requires a value`);
    return { nextIndex: index, value };
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return { nextIndex: index + 1, value };
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function parseLearnArgs(argv: string[]): LearnSubcommandArgs {
  const args: LearnSubcommandArgs = {
    foreground: false,
    help: false,
    repoRoot: process.cwd(),
    skipGeneration: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--background") {
      args.foreground = false;
      continue;
    }
    if (arg === "--foreground") {
      args.foreground = true;
      continue;
    }
    if (arg === "--skip-generation") {
      args.skipGeneration = true;
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
          args.backend = value;
          break;
        case "--candidate":
          args.candidate = value;
          break;
        case "--candidates":
          args.candidateCount = parsePositiveInteger(value, optionName);
          break;
        case "--candidate-file-name":
          args.candidateFileName = value;
          break;
        case "--eval-model":
          args.evalModel = value;
          break;
        case "--env":
          args.target = value;
          break;
        case "--generation-model":
          args.generationModel = value;
          break;
        case "--model":
          args.generationModel = value;
          args.evalModel = value;
          break;
        case "--out":
          args.runDir = value;
          break;
        case "--promote-to":
          args.promoteTo = value;
          break;
        case "--repo-root":
          args.repoRoot = value;
          break;
        case "--scenario-limit":
          args.scenarioLimit = parsePositiveInteger(value, optionName);
          break;
        default:
          throw new Error(`Unknown argument: ${arg}`);
      }
      continue;
    }
    if (args.target) throw new Error(`Unexpected positional argument: ${arg}`);
    args.target = arg;
  }

  return args;
}

function resolveLearningEnvTarget(target: string | undefined): string {
  if (!target) {
    throw new Error(
      "Missing learning env. Pass a built-in env name (for example `memory-citations`) or --env <path>.",
    );
  }
  return BUILTIN_LEARNING_ENVS[target] ?? target;
}

function printLearnUsage(): void {
  console.log(`Usage:
  letta learn <env-name|env.json> [options]

Creates or optimizes a Letta Code mod using the mod-learning workflow. This is the CLI entrypoint for the same workflow as /mods learn: it runs candidate generation in an isolated MetaAgent, evaluates the candidate in headless environments, and writes live/final reports.

Built-in envs:
  memory-citations       Learn the memory-citations example mod
  uv-pip-install         Learn the uv pip install example mod

Options:
  --env <path>                  Learning env JSON (alternative to positional env)
  --out <dir>                   Run artifact directory (default: .letta/mod-learning-runs/<slug>-<timestamp>)
  --candidate <path>            Use an existing candidate mod instead of generation
  --candidates <n>              Run N optimization iterations (default: ${DEFAULT_OPTIMIZATION_STEPS} for generated runs)
  --candidate-file-name <name>  Candidate filename inside the eval mod directory
  --model <handle>              Model for both MetaAgent generation and eval
  --generation-model <handle>   Model for isolated MetaAgent candidate generation
  --eval-model <handle>         Model for headless eval
  --backend <mode>              Backend flag forwarded to headless letta (api or local)
  --scenario-limit <n>          Evaluate only first N scenarios (fast smoke testing)
  --repo-root <path>            Repo root (default: cwd)
  --foreground                  Run in this process and print progress
  --background                  Run detached and print artifact paths (default)
  --skip-generation             Expect the candidate file to already exist in the run dir
  --promote-to <path>           Copy passing candidate to this repo-relative path
  -h, --help                    Show this help

Artifacts:
  progress.html                 Live auto-refreshing timeline and agent/env links
  progress.jsonl                Append-only progress event log
  report.html                   Final static report
  report.md / report.json       Final reports

Examples:
  letta learn memory-citations
  letta learn uv-pip-install --foreground --model claude-sonnet-4-5-20250929
  letta learn --env path/to/my-mod.env.json --candidates 5 --promote-to .letta/mods/my-mod.ts
`);
}

function formatScore(
  score: number | undefined,
  maxScore: number | undefined,
): string {
  if (score === undefined) return "";
  if (maxScore === undefined) return ` score ${score}`;
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  return ` score ${score}/${maxScore} (${percentage}%)`;
}

function progressPrefix(progress: ModLearningProgress): string {
  if (progress.candidateIndex && progress.candidateCount) {
    return `[${progress.candidateIndex}/${progress.candidateCount}]`;
  }
  if (progress.candidateIndex) return `[${progress.candidateIndex}]`;
  return `[${progress.phase}]`;
}

function formatProgressLine(progress: ModLearningProgress): string {
  return `${progressPrefix(progress)} ${progress.message}${formatScore(progress.score, progress.maxScore)}`;
}

async function launchBackground(params: {
  argv: string[];
  outWasProvided: boolean;
  repoRoot: string;
  runDir: string;
}): Promise<void> {
  await mkdir(params.runDir, { recursive: true });
  const stdoutPath = path.join(params.runDir, "background.stdout");
  const stderrPath = path.join(params.runDir, "background.stderr");
  const metadataPath = path.join(params.runDir, "background.json");
  const childArgv = params.argv.filter(
    (arg) => arg !== "--background" && arg !== "--foreground",
  );
  childArgv.push("--foreground");
  if (!params.outWasProvided) childArgv.push("--out", params.runDir);

  const launcher = resolveCurrentLettaLauncher();
  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  let childPid: number | undefined;
  try {
    const child = spawn(
      launcher.command,
      [...launcher.args, "learn", ...childArgv],
      {
        cwd: params.repoRoot,
        detached: true,
        env: process.env,
        stdio: ["ignore", stdoutFd, stderrFd],
      },
    );
    child.unref();
    childPid = child.pid;
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          args: [...launcher.args, "learn", ...childArgv],
          command: launcher.command,
          pid: childPid,
          runDir: params.runDir,
          startedAt: new Date().toISOString(),
          stderrPath,
          stdoutPath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  console.log(`BACKGROUND ${params.runDir}`);
  console.log(`PID ${childPid ?? "unknown"}`);
  console.log(`stdout ${stdoutPath}`);
  console.log(`stderr ${stderrPath}`);
  console.log(`progress tail -f ${stdoutPath}`);
  console.log(`progress ${path.join(params.runDir, "progress.html")}`);
  console.log(`report ${path.join(params.runDir, "report.md")}`);
  console.log(`html ${path.join(params.runDir, "report.html")}`);
}

function candidateForPromote(report: ModLearningReport): string {
  return report.candidatePath;
}

export async function runLearnSubcommand(argv: string[]): Promise<number> {
  let args: LearnSubcommandArgs;
  try {
    args = parseLearnArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    printLearnUsage();
    return 1;
  }

  if (args.help) {
    printLearnUsage();
    return 0;
  }

  let envPath: string;
  try {
    envPath = resolveLearningEnvTarget(args.target);
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    printLearnUsage();
    return 1;
  }

  try {
    const repoRoot = path.resolve(args.repoRoot);
    const learningEnv = await readModLearningEnv(
      path.resolve(repoRoot, envPath),
    );
    const runDir = args.runDir
      ? path.resolve(repoRoot, args.runDir)
      : path.resolve(repoRoot, defaultModLearningRunDirectory(learningEnv));

    if (!args.foreground) {
      await launchBackground({
        argv,
        outWasProvided: args.runDir !== undefined,
        repoRoot,
        runDir,
      });
      return 0;
    }

    const launcher = resolveCurrentLettaLauncher();
    const headlessEnv = await defaultHeadlessEnv();
    let lastProgressLine = "";
    const report = await runModLearning({
      backend: args.backend,
      candidateCount:
        args.candidateCount ??
        (args.candidate || args.skipGeneration
          ? undefined
          : DEFAULT_OPTIMIZATION_STEPS),
      candidateFileName: args.candidateFileName,
      candidateSourcePath: args.candidate,
      cliArgsPrefix: launcher.args,
      cliCommand: launcher.command,
      env: headlessEnv,
      evalModel: args.evalModel,
      generationModel: args.generationModel,
      onProgress: (progress) => {
        const line = formatProgressLine(progress);
        if (line === lastProgressLine) return;
        lastProgressLine = line;
        console.log(line);
      },
      promoteToPath: args.promoteTo,
      repoRoot,
      runDir,
      scenarioLimit: args.scenarioLimit,
      skipGeneration: args.skipGeneration,
      spec: learningEnv,
    });

    const status = report.passed ? "PASS" : "FAIL";
    console.log(`${status} ${report.reportPath}`);
    if (report.progressHtmlPath)
      console.log(`progress ${report.progressHtmlPath}`);
    if (report.reportHtmlPath) console.log(`html ${report.reportHtmlPath}`);
    console.log(`candidate ${candidateForPromote(report)}`);
    if (report.passed) {
      console.log(`promote letta mods promote ${candidateForPromote(report)}`);
    }
    return report.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    return 1;
  }
}
