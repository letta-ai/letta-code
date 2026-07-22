import { parseArgs } from "node:util";
import {
  listAllTrajectories,
  runTrajectoryExport,
  type TrajectoryExportOptions,
} from "@/cli/subcommands/trajectories/export";
import {
  CHECKPOINT_SOURCE,
  listSupportedSources,
} from "@/cli/subcommands/trajectories/sources";

function printUsage(): void {
  console.log(
    `
Usage:
  letta trajectories export [options]
  letta trajectories detect [--json]

Normalize historical coding-agent sessions into a single directory of
trajectory-v1 JSON files, ready for review by memory workers. Discovery and
normalization come from @letta-ai/trajectory (listTrajectories /
normalizeTranscript), so every harness the installed package supports —
Claude Code, Codex, Hermes, Letta, OpenClaw, OpenHands, Deep Agents, and any
added later — is included automatically.

Commands:
  export    Discover native session stores, normalize each session, and write
            <out>/<source>/<session>.json plus a manifest.json index
  detect    Report how many sessions each source's local store holds

Export options:
  --out <dir>                  Output directory (default: /tmp/letta-trajectories)
  --source <name>              Only export this source; repeatable
  --root <source>:<path>       Override a source's store root; repeatable
  --transcript <source>:<path> Also normalize an explicit transcript file;
                               repeatable (e.g. files copied from another
                               machine)
  --deepagents <db>:<thread>   Also normalize a Deep Agents checkpoint from a
                               non-standard SQLite store; repeatable
  --project <path>             Keep only sessions whose recorded working
                               directory starts with this path
  --chunks <n>                 Also write chunks/chunk-NN.json files that
                               partition sessions into n balanced worker chunks
  --json                       Emit the manifest as JSON on stdout
  -h, --help                   Show this help
`.trim(),
  );
}

const TRAJECTORIES_OPTIONS = {
  help: { type: "boolean", short: "h" },
  out: { type: "string" },
  source: { type: "string", multiple: true },
  root: { type: "string", multiple: true },
  transcript: { type: "string", multiple: true },
  deepagents: { type: "string", multiple: true },
  project: { type: "string" },
  chunks: { type: "string" },
  json: { type: "boolean" },
} as const;

const DEFAULT_OUT_DIR = "/tmp/letta-trajectories";

function splitSourceRef(
  value: string,
  flag: string,
): { source: string; path: string } {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid ${flag} "${value}": expected <source>:<path>`);
  }
  return {
    source: value.slice(0, separator),
    path: value.slice(separator + 1),
  };
}

async function runDetect(asJson: boolean): Promise<number> {
  const supported = await listSupportedSources();
  const report: Array<{ source: string; sessions?: number; error?: string }> =
    [];
  for (const source of supported) {
    try {
      const items = await listAllTrajectories(source, undefined);
      report.push({ source, sessions: items.length });
    } catch (error) {
      report.push({
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (asJson) {
    console.log(JSON.stringify({ sources: report }, null, 2));
    return 0;
  }
  for (const entry of report) {
    if (entry.error) {
      console.log(`${entry.source}: listing failed — ${entry.error}`);
    } else {
      const note =
        entry.source === CHECKPOINT_SOURCE
          ? " (checkpoint-backed; needs Python LangGraph to normalize)"
          : "";
      console.log(`${entry.source}: ${entry.sessions} session(s)${note}`);
    }
  }
  return 0;
}

export function parseTrajectoriesArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: TRAJECTORIES_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

export async function runTrajectoriesSubcommand(
  argv: string[],
): Promise<number> {
  let parsed: ReturnType<typeof parseTrajectoriesArgs>;
  try {
    parsed = parseTrajectoriesArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  const [action] = parsed.positionals;
  if (parsed.values.help || action === "help" || !action) {
    printUsage();
    return parsed.values.help || action === "help" ? 0 : 1;
  }

  const asJson = Boolean(parsed.values.json);

  if (action === "detect") {
    return runDetect(asJson);
  }
  if (action !== "export") {
    console.error(`Unknown command: ${action}`);
    printUsage();
    return 1;
  }

  const options: TrajectoryExportOptions = {
    outDir: parsed.values.out || DEFAULT_OUT_DIR,
    sources: parsed.values.source,
    project: parsed.values.project,
    onProgress: asJson ? undefined : (message) => console.log(message),
  };
  try {
    if (parsed.values.root?.length) {
      options.roots = {};
      for (const value of parsed.values.root) {
        const { source, path } = splitSourceRef(value, "--root");
        options.roots[source] = path;
      }
    }
    options.transcripts = parsed.values.transcript?.map((value) =>
      splitSourceRef(value, "--transcript"),
    );
    options.deepagents = parsed.values.deepagents?.map((value) => {
      const separator = value.lastIndexOf(":");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(
          `Invalid --deepagents "${value}": expected <db-path>:<thread-id>`,
        );
      }
      return {
        path: value.slice(0, separator),
        threadId: value.slice(separator + 1),
      };
    });
    if (parsed.values.chunks) {
      const chunks = Number.parseInt(parsed.values.chunks, 10);
      if (!Number.isFinite(chunks) || chunks <= 0) {
        throw new Error(`Invalid --chunks "${parsed.values.chunks}"`);
      }
      options.chunks = chunks;
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  try {
    const manifest = await runTrajectoryExport(options);
    if (asJson) {
      console.log(JSON.stringify(manifest, null, 2));
      return manifest.errors.length > 0 && manifest.sessions.length === 0
        ? 1
        : 0;
    }
    console.log(
      `Exported ${manifest.sessions.length} session(s) to ${manifest.outDir}`,
    );
    for (const [source, counts] of Object.entries(manifest.sources)) {
      console.log(
        `  ${source}: ${counts.exported}/${counts.discovered} exported`,
      );
    }
    if (manifest.errors.length > 0) {
      console.error(
        `${manifest.errors.length} session(s) failed to normalize (see manifest.json errors)`,
      );
    }
    if (manifest.chunks) {
      console.log(
        `Wrote ${manifest.chunks.length} worker chunk file(s) under ${manifest.outDir}/chunks/`,
      );
    }
    console.log(`Manifest: ${manifest.outDir}/manifest.json`);
    return manifest.errors.length > 0 && manifest.sessions.length === 0 ? 1 : 0;
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
