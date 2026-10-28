/** The script `swap` global: exact substring replacement for memory edits. */

/** Replace `old` with `replacement`, throwing unless it matches exactly once. */
export function swap(
  text: unknown,
  old: unknown,
  replacement: unknown,
  options?: unknown,
): string {
  if (typeof text !== "string" || typeof old !== "string" || !old) {
    throw new Error(
      "swap(text, old, new) takes strings; old must be non-empty.",
    );
  }
  if (typeof replacement !== "string") {
    throw new Error("swap() replacement must be a string.");
  }
  const all =
    !!options &&
    typeof options === "object" &&
    (options as { all?: unknown }).all === true;
  const count = text.split(old).length - 1;
  if (count === 0) throw new Error(`swap(): text not found: ${preview(old)}`);
  if (count > 1 && !all) {
    throw new Error(
      `swap(): text matches ${count} times: ${preview(old)}; add surrounding context or pass { all: true }.`,
    );
  }
  return all
    ? text.split(old).join(replacement)
    : text.replace(old, () => replacement);
}

function preview(text: string): string {
  const line = JSON.stringify(text);
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
