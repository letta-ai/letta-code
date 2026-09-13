import type { JsonSchema } from "./model-facing-tool";

const COMPUTER_SECTION_HEADING = "## Running on Another Computer";

/**
 * Remove the `computer` parameter from the Task tool schema. Used when the
 * backend has no environment routing (local backend, self-hosted or remote
 * app server): the computers concept only exists on Letta Cloud, so the
 * option should not be advertised to the model at all.
 */
export function stripComputerFromTaskSchema(schema: JsonSchema): JsonSchema {
  const properties = schema.properties;
  if (!properties || !Object.hasOwn(properties, "computer")) {
    return schema;
  }
  const { computer: _computer, ...rest } = properties;
  return { ...schema, properties: rest };
}

/**
 * Remove the "Running on Another Computer" section from the Task tool
 * description (the heading and everything up to the next `## ` heading).
 */
export function stripComputerFromTaskDescription(description: string): string {
  const start = description.indexOf(COMPUTER_SECTION_HEADING);
  if (start === -1) {
    return description;
  }
  const afterHeading = start + COMPUTER_SECTION_HEADING.length;
  const next = description.indexOf("\n## ", afterHeading);
  const removed =
    next === -1
      ? description.slice(0, start)
      : description.slice(0, start) + description.slice(next + 1);
  return removed.replace(/\n{3,}/g, "\n\n").trimEnd();
}
