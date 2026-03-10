export const INIT_TASK_DESCRIPTION = "Memory init";

const ACTIVE_INIT_TASK_DESCRIPTION_VALUES = [
  INIT_TASK_DESCRIPTION,
  "Initializing memory",
  "Deep memory initialization",
] as const;

export function normalizeTaskDescription(
  value: string | null | undefined,
): string {
  return (value ?? "").trim().toLowerCase();
}

const INTERACTIVE_INIT_TASK_DESCRIPTION = normalizeTaskDescription(
  INIT_TASK_DESCRIPTION,
);

const ACTIVE_INIT_TASK_DESCRIPTIONS = new Set(
  ACTIVE_INIT_TASK_DESCRIPTION_VALUES.map((value) =>
    normalizeTaskDescription(value),
  ),
);

export function isInteractiveInitTaskDescription(description: string): boolean {
  return (
    normalizeTaskDescription(description) === INTERACTIVE_INIT_TASK_DESCRIPTION
  );
}

export function isKnownActiveInitTaskDescription(
  description: string | null | undefined,
): boolean {
  return ACTIVE_INIT_TASK_DESCRIPTIONS.has(
    normalizeTaskDescription(description),
  );
}
