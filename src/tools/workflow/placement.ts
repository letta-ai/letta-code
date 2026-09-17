import type { WorkflowComputer } from "./types.ts";

/** Normalize before hashing so workflow defaults and per-call overrides agree. */
export function normalizeWorkflowComputer(value: unknown): WorkflowComputer {
  if (value === undefined || value === "local") return "local";
  if (typeof value === "string" && value.trim()) return { name: value };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const entry = entries[0];
      if (
        entry &&
        ["name", "id", "connectionId", "deviceId"].includes(entry[0]) &&
        typeof entry[1] === "string" &&
        entry[1].trim()
      ) {
        return { [entry[0]]: entry[1] } as WorkflowComputer;
      }
    }
  }
  throw new Error(
    'computer must be "local", a non-empty computer name, or exactly one of {name}, {deviceId}, {id}, {connectionId}.',
  );
}

export function workflowMaxConcurrent(value: unknown): number {
  if (value === undefined) return 16;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  throw new Error("maxConcurrent must be a positive safe integer.");
}

/** Do not silently ignore placement fields that agent-free SDK queries lack. */
export function rejectUnsupportedPlacement(options: object): void {
  for (const key of ["sandbox", "resources", "environment"]) {
    if (key in options) {
      throw new Error(
        `Workflow does not support ${key}; use computer to select an existing connected computer or sandbox. Fresh managed sandboxes and automatic repository attachment are not supported.`,
      );
    }
  }
}

/** An invoking machine's cwd must never be forwarded to another computer. */
export function workflowQueryPlacement(
  computer: unknown,
  cwd: string | undefined,
  localCwd: string | undefined,
): { backend: "local" | "cloud"; options: Record<string, unknown> } {
  const selected = normalizeWorkflowComputer(computer);
  if (cwd !== undefined && (typeof cwd !== "string" || !cwd.trim())) {
    throw new Error("cwd must be a non-empty path on the selected computer.");
  }
  const effectiveCwd = cwd ?? (selected === "local" ? localCwd : undefined);
  return {
    backend: selected === "local" ? "local" : "cloud",
    options: {
      ...(selected === "local" ? {} : { computer: selected }),
      ...(effectiveCwd === undefined ? {} : { cwd: effectiveCwd }),
    },
  };
}
