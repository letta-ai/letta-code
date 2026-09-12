/**
 * Extraction and validation of the `export const meta = {...}` literal that
 * must open every workflow script.
 *
 * The literal is evaluated in an empty vm context, so any identifier
 * reference, function call, or interpolation inside it throws — this is what
 * enforces the "pure literal" rule.
 */

import vm from "node:vm";
import type { WorkflowMeta } from "./types.ts";

const META_PATTERN = /export\s+const\s+meta\s*=\s*\{/;

/** Find the meta literal's object text via a balanced-brace scan. */
function extractMetaLiteral(script: string): { literal: string; end: number } {
  const match = META_PATTERN.exec(script);
  if (!match) {
    throw new Error(
      "Workflow script must begin with `export const meta = {...}`.",
    );
  }
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let inString: string | null = null;
  for (let i = start; i < script.length; i++) {
    const ch = script[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inString = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { literal: script.slice(start, i + 1), end: i + 1 };
      }
    }
  }
  throw new Error("Unterminated meta literal in workflow script.");
}

function isKebabCase(value: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
}

/** Parse and validate the meta block. Throws with a precise message. */
export function parseWorkflowMeta(script: string): WorkflowMeta {
  const { literal } = extractMetaLiteral(script);
  let parsed: unknown;
  try {
    // Empty context: any non-literal expression (identifier, call, spread of
    // a variable) references an undefined global and throws here.
    parsed = new vm.Script(`(${literal})`).runInContext(vm.createContext({}), {
      timeout: 1000,
    });
  } catch (error) {
    throw new Error(
      `The meta block must be a pure literal (no variables, calls, or interpolation): ${String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("meta must be an object literal.");
  }
  const meta = parsed as Record<string, unknown>;
  if (typeof meta.name !== "string" || !meta.name) {
    throw new Error("meta.name is required and must be a non-empty string.");
  }
  if (!isKebabCase(meta.name)) {
    throw new Error(`meta.name must be kebab-case, got "${meta.name}".`);
  }
  if (typeof meta.description !== "string" || !meta.description) {
    throw new Error("meta.description is required.");
  }
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases))
      throw new Error("meta.phases must be an array.");
    for (const phase of meta.phases) {
      if (
        typeof phase !== "object" ||
        phase === null ||
        typeof (phase as Record<string, unknown>).title !== "string"
      ) {
        throw new Error("Each meta.phases entry needs a string title.");
      }
    }
  }
  return meta as unknown as WorkflowMeta;
}

/** Rewrite `export const meta` so the body can run inside a vm script. */
export function stripMetaExport(script: string): string {
  return script.replace(META_PATTERN, (m) => m.replace(/^export\s+/, ""));
}
