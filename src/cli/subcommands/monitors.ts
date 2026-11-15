import { parseArgs } from "node:util";
import { listMonitorStates } from "@/backend/api/monitors";
import { settingsManager } from "@/settings-manager";
import { readResumableMonitor } from "@/tools/impl/monitor-resume";

interface MonitorsDeps {
  initializeSettings?: () => Promise<void>;
  list?: typeof listMonitorStates;
  read?: typeof readResumableMonitor;
  print?: (text: string) => void;
}

const HELP = `Usage:
  letta monitors list [--agent <id>] [--status <s>] [--json]
  letta monitors resume <id>

List defaults to $CONVERSATION_ID / $LETTA_CONVERSATION_ID; --agent lists agent-wide records.
Resume prints the exact tool call to run in the owning conversation's live harness.
  -h, --help  Show this help`;

export async function runMonitorsSubcommand(
  argv: string[],
  deps: MonitorsDeps = {},
): Promise<number> {
  const print = deps.print ?? console.log;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        agent: { type: "string" },
        status: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help || !positionals.length || positionals[0] === "help") {
      print(HELP);
      return values.help || positionals[0] === "help" ? 0 : 1;
    }
    await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
    if (positionals[0] === "resume" && positionals.length === 2) {
      const record = await (deps.read ?? readResumableMonitor)(
        positionals[1] ?? "",
      );
      const tool =
        record.kind === "github_pull_request" ? "WatchPR" : "Monitor";
      // This CLI is a separate process. Sandbox/cron commands use server APIs,
      // not a local listener tool-execution channel; the harness must own it.
      print(
        `Run this tool call in the original conversation's running harness:\n${tool}(${JSON.stringify({ resume: record.monitor_id })})`,
      );
      return 0;
    }
    if (positionals[0] !== "list" || positionals.length !== 1)
      throw new Error(HELP);
    const scope: {
      agent_id?: string;
      conversation_id?: string;
      status?: string;
      after?: string;
    } = { status: values.status };
    if (values.agent) scope.agent_id = values.agent;
    else {
      scope.conversation_id =
        process.env.CONVERSATION_ID || process.env.LETTA_CONVERSATION_ID;
      if (!scope.conversation_id)
        throw new Error("Set CONVERSATION_ID or pass --agent <id>.");
      if (scope.conversation_id === "default") {
        scope.agent_id = process.env.LETTA_AGENT_ID || process.env.AGENT_ID;
        if (!scope.agent_id)
          throw new Error(
            "The default conversation also requires LETTA_AGENT_ID or AGENT_ID.",
          );
      }
    }
    const list = deps.list ?? listMonitorStates;
    const records = [];
    // List's API is cursor-paginated; walk only this explicit user's request.
    for (;;) {
      const page = await list(scope);
      records.push(...page);
      if (page.length < 200) break;
      scope.after = page.at(-1)?.monitor_id;
    }
    if (values.json) print(JSON.stringify(records, null, 2));
    else {
      const clean = (value: string | null | undefined) =>
        Array.from(value ?? "-", (char) =>
          char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char,
        ).join("");
      print(
        [
          "ID\tKIND\tDESCRIPTION\tSTATUS\tSTARTED\tEXPIRES\tCOMMAND / PR",
          ...records.map((row) =>
            [
              row.monitor_id,
              row.kind,
              row.description,
              row.status,
              row.started_at,
              row.expires_at,
              row.command,
            ]
              .map(clean)
              .join("\t"),
          ),
        ].join("\n"),
      );
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
