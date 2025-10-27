export function validateRequiredParams(
  args: Record<string, unknown>,
  required: string[],
  toolName: string,
): void {
  const missing = required.filter((key) => args[key] === undefined);
  if (missing.length > 0) {
    const received = Object.keys(args).join(", ");
    throw new Error(
      `${toolName} tool missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
        `Received parameters: ${received}`,
    );
  }
}
