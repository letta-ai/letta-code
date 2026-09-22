/**
 * Raw serialized error payloads (e.g. a stringified `{ error: ... }` body)
 * are machine detail, not user-facing prose: they can carry internal
 * infrastructure information — hostnames, connection errors, stack-specific
 * messages — that must never reach end-user surfaces.
 */
export function isRawErrorPayloadText(
  errorText: string | null | undefined,
): boolean {
  if (!errorText) return false;
  const trimmed = errorText.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && "error" in parsed;
  } catch {
    return false;
  }
}
