import { getCurrentAgentId } from "@/agent/context";
import {
  clearArtifactDebugSnapshot,
  getArtifactDebugSnapshot,
  listArtifactDebugSnapshots,
} from "@/websocket/listener/commands/artifact-debug-store";

interface ArtifactDebugLogsArgs {
  app_name?: string;
  clear?: boolean;
  limit?: number;
}

function getLogLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(200, Math.floor(value)));
}

export async function artifact_debug_logs(
  args: ArtifactDebugLogsArgs,
): Promise<{
  content: string;
}> {
  const agentId = getCurrentAgentId();
  if (!agentId) {
    throw new Error("artifact_debug_logs: current agent id is unavailable");
  }

  if (!args.app_name) {
    const snapshots = listArtifactDebugSnapshots(agentId);
    return {
      content:
        snapshots.length === 0
          ? "No artifact debug log snapshots are available for this agent. Open an artifact in the UI and reproduce the issue first."
          : snapshots
              .map(
                (snapshot) =>
                  `${snapshot.appName}: html=${snapshot.htmlLogs.length}, server=${snapshot.serverLogs.length}, updated=${snapshot.updatedAt}`,
              )
              .join("\n"),
    };
  }

  if (args.clear) {
    const cleared = clearArtifactDebugSnapshot({
      agentId,
      appName: args.app_name,
    });
    return {
      content: cleared
        ? `Cleared artifact debug logs for ${args.app_name}.`
        : `No artifact debug logs were stored for ${args.app_name}.`,
    };
  }

  const snapshot = getArtifactDebugSnapshot({
    agentId,
    appName: args.app_name,
  });
  if (!snapshot) {
    return {
      content: `No artifact debug logs are available for ${args.app_name}. Open the artifact in the UI and reproduce the issue first.`,
    };
  }

  const formatLog = (log: {
    timestamp: string;
    source: string;
    level: string;
    message: string;
    requestId?: string;
    functionName?: string;
  }): string => {
    const details = [log.functionName, log.requestId].filter(Boolean).join(" ");
    return `[${log.timestamp}] [${log.source}] [${log.level}]${details ? ` ${details}` : ""} ${log.message}`;
  };

  const limit = getLogLimit(args.limit);
  const htmlLogs = limit === 0 ? [] : snapshot.htmlLogs.slice(-limit);
  const serverLogs = limit === 0 ? [] : snapshot.serverLogs.slice(-limit);

  return {
    content: [
      `Artifact: ${snapshot.appName}`,
      `Updated: ${snapshot.updatedAt}`,
      `Showing last ${limit} logs per source. HTML total: ${snapshot.htmlLogs.length}. Server/system total: ${snapshot.serverLogs.length}.`,
      "",
      "HTML logs:",
      htmlLogs.map(formatLog).join("\n") || "(none)",
      "",
      "Server/system logs:",
      serverLogs.map(formatLog).join("\n") || "(none)",
    ].join("\n"),
  };
}
