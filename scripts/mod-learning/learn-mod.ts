#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  builtInDatasetAdapterConfig,
  builtInDatasetLearningEnv,
} from "../../src/mods/dataset-presets.ts";
import {
  defaultModLearningRunDirectory,
  readModLearningEnv,
  runModLearning,
} from "../../src/mods/learning-harness.ts";

interface Args {
  backend?: string;
  candidate?: string;
  candidateCount?: number;
  candidateFileName?: string;
  dataset?: string;
  datasetAdapterCommand?: string;
  datasetSubset?: string;
  datasetTaskIds?: string[];
  datasetTrials?: number;
  evalModel?: string;
  generationModel?: string;
  help: boolean;
  env: string;
  foreground: boolean;
  out?: string;
  promoteTo?: string;
  repoRoot: string;
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
        case "--dataset":
          args.dataset = value;
          break;
        case "--dataset-adapter-command":
          args.datasetAdapterCommand = value;
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
        case "--subset":
          args.datasetSubset = value;
          break;
        case "--task":
          args.datasetTaskIds = [
            ...(args.datasetTaskIds ?? []),
            ...value
              .split(",")
              .map((taskId) => taskId.trim())
              .filter(Boolean),
          ];
          break;
        case "--trials":
          args.datasetTrials = Number(value);
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
  --candidates <n>              Generate/evaluate N candidates, each seeing prior attempts (default: 1)
  --candidate-file-name <name>  Candidate filename inside the eval mod directory
  --dataset <name>              Use a host-filesystem dataset adapter instead of env scenarios
  --subset <name>               Dataset subset (terminalbench default: smoke)
  --task <id>[,<id>]            Restrict dataset evaluation to task id(s)
  --trials <n>                  Dataset trials per task
  --dataset-adapter-command <cmd> Override built-in host adapter executable
  --model <handle>              Model for generation and eval
  --generation-model <handle>   Model for candidate generation
  --eval-model <handle>         Model for headless eval
  --backend <mode>              Backend flag forwarded to letta (api or local)
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
  console.log(`report ${path.join(params.runDir, "report.md")}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(args.repoRoot);
  const learningEnv = args.dataset
    ? builtInDatasetLearningEnv(args.dataset, args.datasetSubset)
    : await readModLearningEnv(path.resolve(repoRoot, args.env));
  if (!learningEnv) throw new Error(`Unknown dataset: ${args.dataset}`);
  const dataset = args.dataset
    ? builtInDatasetAdapterConfig({
        adapterCommand: args.datasetAdapterCommand,
        dataset: args.dataset,
        repoRoot,
        subset: args.datasetSubset,
        taskIds: args.datasetTaskIds,
        trials: args.datasetTrials,
      })
    : undefined;
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

  const report = await runModLearning({
    backend: args.backend,
    candidateCount: args.candidateCount,
    candidateFileName: args.candidateFileName,
    candidateSourcePath: args.candidate,
    dataset,
    evalModel: args.evalModel,
    generationModel: args.generationModel,
    promoteToPath: args.promoteTo,
    repoRoot,
    runDir,
    skipGeneration: args.skipGeneration,
    spec: learningEnv,
  });

  const status = report.datasetEvaluation
    ? "SCORED"
    : report.passed
      ? "PASS"
      : "FAIL";
  console.log(`${status} ${report.reportPath}`);
  if (!report.datasetEvaluation && !report.passed) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
