export interface MemoryFileFrontmatterInput {
  path: string;
  content: string;
  /** Accepted contents of this path, never contents supplied by the change. */
  previousContent: string | null;
  format: "memfs-v2" | "legacy";
}

/**
 * Canonical content checks used by the installed hook and external tree readers.
 * The caller selects projected paths and supplies the trusted layout/base.
 * Legacy callers select added/modified files; v2 callers select the whole tree.
 * Ref operations, deletion/rename protection and policy authorization remain
 * caller responsibilities, not decisions made from the proposed file contents.
 * This is deliberately self-contained: the Git hook embeds its source so it
 * does not depend on a package installation in the memory repository.
 */
export function validateMemoryFileFrontmatter({
  path,
  content,
  previousContent,
  format,
}: MemoryFileFrontmatterInput): string[] {
  const errors: string[] = [];
  const v2 = format === "memfs-v2";
  const lines = content.split("\n");
  if (v2 && path.split("/").at(-1) === "MEMORY.md") {
    return lines[0] === "---"
      ? [`${path}: MEMORY.md must not have frontmatter`]
      : [];
  }
  if (lines[0] !== "---") {
    return [`${path}: missing frontmatter (must start with ---)`];
  }
  const closing = lines.indexOf("---", 1);
  if (closing < 0) {
    return [
      `${path}: frontmatter opened but never closed (missing closing ---)`,
    ];
  }

  // Match the legacy hook's scalar protected field lookup. Do not interpret
  // YAML or turn a quoted value into a different authorization decision.
  function legacyValue(text: string | null, key: string): string {
    const previousLines = text?.split("\n") ?? [];
    const end = previousLines.indexOf("---", 1);
    if (end < 0) return "";
    return previousLines
      .slice(1, end)
      .filter((line) => line.startsWith(`${key}:`))
      .map((line) => line.slice(key.length + 1).replace(/^ +| +$/g, ""))
      .join("\n");
  }

  if (
    !v2 &&
    previousContent &&
    legacyValue(previousContent, "read_only") === "true"
  ) {
    return [`${path}: file is read_only and cannot be modified`];
  }

  const seen = new Set<string>();
  const allowed = v2
    ? ["name", "description"]
    : ["description", "read_only", "limit"];
  for (const line of lines.slice(1, closing)) {
    if (!line) continue;
    // Legacy descriptions permit YAML continuation lines. V2 uses two scalar
    // fields, as in the existing hook, and rejects extra lines/keys.
    if (!v2 && /^[ \t]/.test(line)) continue;
    const separator = line.indexOf(":");
    const rawKey = separator < 0 ? line : line.slice(0, separator);
    const key = v2
      ? rawKey.replace(/^ +| +$/g, "")
      : rawKey.replaceAll(" ", "");
    const value = (separator < 0 ? line : line.slice(separator + 1)).replace(
      /^ +| +$/g,
      "",
    );
    if (!allowed.includes(key)) {
      errors.push(
        `${path}: unknown frontmatter key '${key}' (allowed: ${allowed.join(" ")})`,
      );
      continue;
    }
    if (v2 && seen.has(key)) {
      errors.push(`${path}: duplicate frontmatter key '${key}'`);
    }
    seen.add(key);
    if (key === "read_only") {
      if (!previousContent) {
        errors.push(
          `${path}: 'read_only' is a protected field and cannot be set by the agent`,
        );
      } else if (value !== legacyValue(previousContent, key)) {
        errors.push(
          `${path}: 'read_only' is a protected field and cannot be changed by the agent`,
        );
      }
    }
    if (
      (v2 || key === "description") &&
      (!value || (v2 && (value === '""' || value === "''")))
    ) {
      errors.push(`${path}: '${key}' must not be empty`);
    }
  }
  for (const key of v2 ? ["name", "description"] : ["description"]) {
    if (!seen.has(key)) errors.push(`${path}: missing required field '${key}'`);
  }
  if (
    !v2 &&
    legacyValue(previousContent, "read_only") &&
    !legacyValue(content, "read_only")
  ) {
    errors.push(
      `${path}: 'read_only' is a protected field and cannot be removed by the agent`,
    );
  }
  return errors;
}
