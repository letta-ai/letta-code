import { reportSubagentStdoutLoss } from "@/utils/subagent-stdout-failure";

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

    throw err;
  });
}
