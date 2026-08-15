function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isRuntimeStartCreateAgentOptions(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    isObjectRecord(value.body) &&
    (value.pin_global === undefined || typeof value.pin_global === "boolean") &&
    (value.memfs === undefined || typeof value.memfs === "boolean")
  );
}

export function isRuntimeStartCreateConversationOptions(
  value: unknown,
): boolean {
  if (!isObjectRecord(value)) return false;
  return value.body === undefined || isObjectRecord(value.body);
}

export function isRuntimeStartClientInfo(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.version === undefined || typeof value.version === "string")
  );
}

export function isRuntimeStartWorkspaceSandbox(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.root === "string" && typeof value.isolation_root === "string"
  );
}
