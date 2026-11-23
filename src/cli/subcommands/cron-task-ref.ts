import { isLocalAgentId } from "@/agent/agent-id";
import { listCloudSchedulesByExactMatch } from "@/backend/api/schedules";
import { resolveBackendMode } from "@/backend/backend-mode";
import { listTasks } from "@/cron";

export interface ResolvedTaskRef {
  id: string;
  store: "local" | "cloud";
}

export async function ensureSettingsForCloud(): Promise<void> {
  const { settingsManager } = await import("@/settings-manager");
  await settingsManager.initialize();
}

export function canManageCloudSchedules(agentId: string): boolean {
  return resolveBackendMode() === "api" && !isLocalAgentId(agentId);
}

export async function resolveTaskName(
  name: string,
  options: {
    agentId: string;
  },
): Promise<ResolvedTaskRef | { ambiguous: ResolvedTaskRef[] } | null> {
  const matches: ResolvedTaskRef[] = [];

  for (const task of listTasks()) {
    if (task.name === name) {
      matches.push({ id: task.id, store: "local" });
    }
  }

  if (options.agentId && canManageCloudSchedules(options.agentId)) {
    try {
      await ensureSettingsForCloud();
      const schedules = await listCloudSchedulesByExactMatch(options.agentId, {
        name,
      });
      for (const schedule of schedules) {
        matches.push({ id: schedule.id, store: "cloud" });
      }
    } catch {}
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;
  return { ambiguous: matches };
}

export function printAmbiguousTaskName(
  name: string,
  matches: ResolvedTaskRef[],
): void {
  console.error(
    `Error: multiple tasks are named "${name}". Use an ID instead:`,
  );
  for (const match of matches) {
    console.error(`  ${match.id} (${match.store})`);
  }
}
