export function validateRequiredParams<T extends object>(
  args: T,
  required: string[],
  toolName: string,
): void {
  const missing = required.filter((key) => !(key in args));
  if (missing.length > 0) {
    const received = Object.keys(args).join(", ");
    throw new Error(
      `${toolName} tool missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
        `Received parameters: ${received}`,
    );
  }
}
