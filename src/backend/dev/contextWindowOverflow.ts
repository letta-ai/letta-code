function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contextOverflowHaystack(error: unknown): string {
  const pieces: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (value === undefined || value === null || depth > 3) return;
    if (typeof value === "string") {
      pieces.push(value);
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      pieces.push(String(value));
      return;
    }
    if (value instanceof Error) {
      pieces.push(value.name, value.message);
      for (const [key, item] of Object.entries(
        value as unknown as Record<string, unknown>,
      )) {
        pieces.push(key);
        visit(item, depth + 1);
      }
      visit((value as { cause?: unknown }).cause, depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        pieces.push(key);
        visit(item, depth + 1);
      }
    }
  };
  visit(error, 0);
  return pieces.join("\n").toLowerCase();
}

export function isContextWindowOverflowError(error: unknown): boolean {
  const haystack = contextOverflowHaystack(error);
  return [
    "context_length_exceeded",
    "context window",
    "maximum context length",
    "max context length",
    "prompt is too long",
    "input is too long",
    "too many tokens",
    "exceeds the context",
    "exceeded the context",
    "reduce the length",
    "request too large",
    "request_too_large",
    "model_context_window_exceeded",
  ].some((marker) => haystack.includes(marker));
}
