#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultModLearningRunDirectory,
  type ModLearningProgress,
  type ModLearningReport,
  readModLearningEnv,
  runModLearning,
} from "../../src/mods/learning-harness.ts";

const DEFAULT_OPTIMIZATION_STEPS = 5;

interface Args {
  backend?: string;
  candidate?: string;
  candidateCount?: number;
  candidateFileName?: string;
  evalModel?: string;
  generationModel?: string;
  help: boolean;
  env: string;
  foreground: boolean;
  out?: string;
  promoteTo?: string;
  repoRoot: string;
  scenarioLimit?: number;
  skipGeneration: boolean;
}

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

function parseArgs(argv: string[]): Args {
  const args: Args = {
    env: "docs/examples/mods/learning/memory-citations.env.json",
    foreground: false,
    help: false,
    repoRoot: process.cwd(),
    skipGeneration: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--background") {
      args.foreground = false;
    } else if (arg === "--foreground") {
      args.foreground = true;
    } else if (arg === "--skip-generation") {
      args.skipGeneration = true;
    } else if (arg?.startsWith("--")) {
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
          args.candidateCount = Number(value);
          break;
        case "--candidate-file-name":
          args.candidateFileName = value;
          break;
        case "--eval-model":
          args.evalModel = value;
          break;
        case "--env":
          args.env = value;
          break;
        case "--generation-model":
          args.generationModel = value;
          break;
        case "--model":
          args.generationModel = value;
          args.evalModel = value;
          break;
        case "--out":
          args.out = value;
          break;
        case "--promote-to":
          args.promoteTo = value;
          break;
        case "--repo-root":
          args.repoRoot = value;
          break;
        case "--scenario-limit":
          args.scenarioLimit = Number(value);
          break;
        default:
          throw new Error(`Unknown argument: ${arg}`);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Usage: bun scripts/mod-learning/learn-mod.ts [options]

Runs the mod learning dogfood loop:
  env/demo -> generate candidate mod -> headless eval with LETTA_MODS_DIR (and legacy LETTA_EXTENSIONS_DIR for pre-rename branches) -> artifacts/report

Options:
  --env <path>                  Learning env JSON (default: memory-citations env)
  --out <dir>                   Run artifact directory (default: .letta/mod-learning-runs/<slug>-<timestamp>)
  --candidate <path>            Use an existing candidate mod instead of generation
  --candidates <n>              Run N optimization iterations for one learned mod (default: 5 for generated runs)
  --candidate-file-name <name>  Candidate filename inside the eval mod directory
  --model <handle>              Model for generation and eval
  --generation-model <handle>   Model for candidate generation
  --eval-model <handle>         Model for headless eval
  --backend <mode>              Backend flag forwarded to letta (api or local)
  --scenario-limit <n>          Evaluate only the first N scenarios (fast smoke testing)
  --repo-root <path>            Repo root (default: cwd)
  --foreground                  Run learning in this process and return a pass/fail exit code
  --background                  Explicitly use the default detached mode
  --skip-generation             Expect the candidate file to already exist in the run dir
  --promote-to <path>           Copy passing candidate to this repo-relative path
  -h, --help                    Show this help
`);
}

async function launchBackground(params: {
  argv: string[];
  repoRoot: string;
  runDir: string;
  outWasProvided: boolean;
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

  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  let childPid: number | undefined;
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), ...childArgv],
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
          args: childArgv,
          command: process.execPath,
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
  console.log(`report ${path.join(params.runDir, "report.md")}`);
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

function candidateForPromote(report: ModLearningReport): string {
  return report.candidatePath;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(args.repoRoot);
  const learningEnv = await readModLearningEnv(
    path.resolve(repoRoot, args.env),
  );
  const runDir = args.out
    ? path.resolve(repoRoot, args.out)
    : path.resolve(repoRoot, defaultModLearningRunDirectory(learningEnv));

  if (!args.foreground) {
    await launchBackground({
      argv,
      outWasProvided: args.out !== undefined,
      repoRoot,
      runDir,
    });
    return;
  }

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
    evalModel: args.evalModel,
    generationModel: args.generationModel,
    promoteToPath: args.promoteTo,
    repoRoot,
    runDir,
    scenarioLimit: args.scenarioLimit,
    skipGeneration: args.skipGeneration,
    spec: learningEnv,
    onProgress: (progress) => {
      const line = formatProgressLine(progress);
      if (line === lastProgressLine) return;
      lastProgressLine = line;
      console.log(line);
    },
  });

  const status = report.passed ? "PASS" : "FAIL";
  console.log(`${status} ${report.reportPath}`);
  console.log(`candidate ${candidateForPromote(report)}`);
  if (report.passed) {
    console.log(`promote letta mods promote ${candidateForPromote(report)}`);
  }
  if (!report.passed) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
