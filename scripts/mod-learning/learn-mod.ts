#!/usr/bin/env bun
import path from "node:path";
import {
  defaultModLearningRunDirectory,
  readModLearningSpec,
  runModLearning,
} from "../../src/mods/learning-harness.ts";

interface Args {
  backend?: string;
  candidate?: string;
  candidateFileName?: string;
  evalModel?: string;
  generationModel?: string;
  help: boolean;
  out?: string;
  promoteTo?: string;
  repoRoot: string;
  skipGeneration: boolean;
  spec: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    repoRoot: process.cwd(),
    skipGeneration: false,
    spec: "docs/examples/mods/learning/memory-citations.spec.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--spec") {
      args.spec = argv[++index] ?? args.spec;
    } else if (arg === "--out") {
      args.out = argv[++index];
    } else if (arg === "--candidate") {
      args.candidate = argv[++index];
    } else if (arg === "--candidate-file-name") {
      args.candidateFileName = argv[++index];
    } else if (arg === "--generation-model") {
      args.generationModel = argv[++index];
    } else if (arg === "--eval-model") {
      args.evalModel = argv[++index];
    } else if (arg === "--model") {
      const model = argv[++index];
      args.generationModel = model;
      args.evalModel = model;
    } else if (arg === "--backend") {
      args.backend = argv[++index];
    } else if (arg === "--repo-root") {
      args.repoRoot = argv[++index] ?? args.repoRoot;
    } else if (arg === "--skip-generation") {
      args.skipGeneration = true;
    } else if (arg === "--promote-to") {
      args.promoteTo = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Usage: bun scripts/mod-learning/learn-mod.ts [options]

Runs the mod learning dogfood loop:
  spec/demo -> generate candidate mod -> headless eval with LETTA_MODS_DIR (and legacy LETTA_EXTENSIONS_DIR for pre-rename branches) -> artifacts/report

Options:
  --spec <path>                 Learning spec JSON (default: memory-citations spec)
  --out <dir>                   Run artifact directory (default: .letta/mod-learning-runs/<slug>-<timestamp>)
  --candidate <path>            Use an existing candidate mod instead of generation
  --candidate-file-name <name>  Candidate filename inside the eval mod directory
  --model <handle>              Model for generation and eval
  --generation-model <handle>   Model for candidate generation
  --eval-model <handle>         Model for headless eval
  --backend <mode>              Backend flag forwarded to letta (api or local)
  --repo-root <path>            Repo root (default: cwd)
  --skip-generation             Expect the candidate file to already exist in the run dir
  --promote-to <path>           Copy passing candidate to this repo-relative path
  -h, --help                    Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(args.repoRoot);
  const specPath = path.resolve(repoRoot, args.spec);
  const spec = await readModLearningSpec(specPath);
  const runDir = args.out
    ? path.resolve(repoRoot, args.out)
    : path.resolve(repoRoot, defaultModLearningRunDirectory(spec));

  const report = await runModLearning({
    backend: args.backend,
    candidateFileName: args.candidateFileName,
    candidateSourcePath: args.candidate,
    evalModel: args.evalModel,
    generationModel: args.generationModel,
    promoteToPath: args.promoteTo,
    repoRoot,
    runDir,
    skipGeneration: args.skipGeneration,
    spec,
  });

  console.log(`${report.passed ? "PASS" : "FAIL"} ${report.reportPath}`);
  if (!report.passed) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
