import { AsyncLocalStorage } from "node:async_hooks";
import type { SkillSource } from "./agent/skills";

export type RuntimePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "memory"
  | "bypassPermissions";

export interface RuntimeContextSnapshot {
  agentId?: string | null;
  conversationId?: string | null;
  skillsDirectory?: string | null;
  skillSources?: SkillSource[];
  workingDirectory?: string | null;
  permissionMode?: RuntimePermissionMode;
  planFilePath?: string | null;
  modeBeforePlan?: RuntimePermissionMode | null;
}

const runtimeContextStorage = new AsyncLocalStorage<RuntimeContextSnapshot>();

export function getRuntimeContext(): RuntimeContextSnapshot | undefined {
  return runtimeContextStorage.getStore();
}

export function runWithRuntimeContext<T>(
  snapshot: RuntimeContextSnapshot,
  fn: () => T,
): T {
  const parent = runtimeContextStorage.getStore();
  return runtimeContextStorage.run(
    {
      ...parent,
      ...snapshot,
      ...(snapshot.skillSources
        ? { skillSources: [...snapshot.skillSources] }
        : {}),
    },
    fn,
  );
}

export function runOutsideRuntimeContext<T>(fn: () => T): T {
  return runtimeContextStorage.exit(fn);
}

export function updateRuntimeContext(
  update: Partial<RuntimeContextSnapshot>,
): void {
  const current = runtimeContextStorage.getStore();
  if (!current) {
    return;
  }

  Object.assign(
    current,
    update,
    update.skillSources && {
      skillSources: [...update.skillSources],
    },
  );
}

export function getCurrentWorkingDirectory(): string {
  const workingDirectory = runtimeContextStorage.getStore()?.workingDirectory;
  if (typeof workingDirectory === "string" && workingDirectory.length > 0) {
    return workingDirectory;
  }
  return process.env.USER_CWD || process.cwd();
}
