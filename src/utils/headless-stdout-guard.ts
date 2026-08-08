import { reportSubagentStdoutLoss } from "@/utils/subagent-stdout-failure";

/**
 * Install the process-level stdout error handler for headless mode. Must be
 * registered before any headless output is written.
 *
 * If headless output is being piped and the downstream closes early (e.g.
 * `| head`), Node will throw EPIPE on stdout writes. Treat this as a normal
 * termination rather than crashing with a stack trace.
 *
 * A subagent child is the exception: once its stdout is gone it can never
 * deliver its result envelope, and a clean exit would make the parent parse
 * a truncated stream (#3257). Exit non-zero with a marker on stderr so the
 * parent retries the spawn instead. Rethrowing wouldn't surface this — the
 * global uncaughtException handler swallows the rethrow and the process
 * would still exit 0 later.
 */
export function installHeadlessStdoutGuard(): void {
  process.stdout.on("error", (err: unknown) => {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;

    if (process.env.LETTA_PARENT_AGENT_ID) {
      reportSubagentStdoutLoss(code ?? err);
      process.exit(1);
    }

    if (code === "EPIPE") {
      process.exit(0);
    }

    // Re-throw unknown stdout errors so they surface during tests/debugging.
    throw err;
  });
}
