#!/usr/bin/env bun
/** Validates and encodes one agent-authored review result for the runner. */

import { readAnalysis, readReviewResult } from "./update-tracker.ts";

interface Args {
  analysisFile: string | null;
  resultFile: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { analysisFile: null, resultFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--analysis-file") {
      args.analysisFile = argv[++index] ?? null;
    } else if (arg === "--result-file") {
      args.resultFile = argv[++index] ?? null;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun scripts/builtin-skills-watch/finalize-result.ts --analysis-file FILE --result-file FILE",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.analysisFile || !args.resultFile) {
    throw new Error("--analysis-file and --result-file are required");
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const analysis = readAnalysis(args.analysisFile as string);
  const result = readReviewResult(args.resultFile as string, analysis);
  const encoded = Buffer.from(JSON.stringify(result), "utf8").toString(
    "base64",
  );
  console.log(`SKILL_WATCH_RESULT ${encoded}`);
}

if (import.meta.main) main();
