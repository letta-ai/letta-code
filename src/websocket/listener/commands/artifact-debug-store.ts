export type ArtifactDebugLogSource = "html" | "server" | "system";
export type ArtifactDebugLogLevel = "log" | "info" | "warn" | "error" | "debug";

export interface ArtifactDebugLogEntry {
  source: ArtifactDebugLogSource;
  level: ArtifactDebugLogLevel;
  message: string;
  timestamp: string;
  requestId?: string;
  functionName?: string;
}

export interface ArtifactDebugSnapshot {
  agentId: string;
  appName: string;
  htmlLogs: ArtifactDebugLogEntry[];
  serverLogs: ArtifactDebugLogEntry[];
  updatedAt: string;
}

const MAX_LOGS_PER_SOURCE = 200;
const snapshots = new Map<string, ArtifactDebugSnapshot>();

function getSnapshotKey(input: { agentId: string; appName: string }): string {
  return `${input.agentId}:${input.appName}`;
}

function normalizeLogs(logs: ArtifactDebugLogEntry[]): ArtifactDebugLogEntry[] {
  return logs.slice(-MAX_LOGS_PER_SOURCE);
}

export function setArtifactDebugSnapshot(input: {
  agentId: string;
  appName: string;
  htmlLogs: ArtifactDebugLogEntry[];
  serverLogs: ArtifactDebugLogEntry[];
}): void {
  snapshots.set(getSnapshotKey(input), {
    agentId: input.agentId,
    appName: input.appName,
    htmlLogs: normalizeLogs(input.htmlLogs),
    serverLogs: normalizeLogs(input.serverLogs),
    updatedAt: new Date().toISOString(),
  });
}

export function appendArtifactServerDebugLogs(input: {
  agentId: string;
  appName: string;
  logs: ArtifactDebugLogEntry[];
}): void {
  const key = getSnapshotKey(input);
  const existing = snapshots.get(key);
  snapshots.set(key, {
    agentId: input.agentId,
    appName: input.appName,
    htmlLogs: existing?.htmlLogs ?? [],
    serverLogs: normalizeLogs([...(existing?.serverLogs ?? []), ...input.logs]),
    updatedAt: new Date().toISOString(),
  });
}

export function getArtifactDebugSnapshot(input: {
  agentId: string;
  appName: string;
}): ArtifactDebugSnapshot | null {
  return snapshots.get(getSnapshotKey(input)) ?? null;
}

export function clearArtifactDebugSnapshot(input: {
  agentId: string;
  appName: string;
}): boolean {
  return snapshots.delete(getSnapshotKey(input));
}

export function listArtifactDebugSnapshots(
  agentId: string,
): ArtifactDebugSnapshot[] {
  return [...snapshots.values()]
    .filter((snapshot) => snapshot.agentId === agentId)
    .sort((a, b) => a.appName.localeCompare(b.appName));
}
