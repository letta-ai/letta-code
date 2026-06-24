import { parseArgs } from "node:util";
import { getLocalBackendStorageDir } from "@/backend/local/paths";
import { migrateLocalBackendTranscripts } from "@/backend/local/transcript-migration";

const LOCAL_BACKEND_OPTIONS = {
  help: { type: "boolean", short: "h" },
  "storage-dir": { type: "string" },
  "dry-run": { type: "boolean" },
} as const;

function parseLocalBackendArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: LOCAL_BACKEND_OPTIONS,
    strict: true,
  });
}

function printUsage(): void {
  console.log(
    `
Usage:
  letta local-backend migrate-transcripts [--storage-dir <path>] [--dry-run]

Migrates unversioned experimental local backend transcripts to the
versioned pi-ai transcript format. Each converted messages.jsonl is backed up
before it is replaced.
`.trim(),
  );
}

export async function runLocalBackendSubcommand(
  argv: string[],
): Promise<number> {
  const [command, ...rest] = argv;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    printUsage();
    return command ? 0 : 1;
  }
  if (command !== "migrate-transcripts") {
    console.error(`Unknown local-backend command: ${command}`);
    printUsage();
    return 1;
  }

  let parsed: ReturnType<typeof parseLocalBackendArgs>;
  try {
    parsed = parseLocalBackendArgs(rest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    printUsage();
    return 1;
  }
  if (parsed.values.help) {
    printUsage();
    return 0;
  }
  const storageDir =
    parsed.values["storage-dir"] ?? getLocalBackendStorageDir();
  const result = migrateLocalBackendTranscripts({
    storageDir,
    dryRun: parsed.values["dry-run"] === true,
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
