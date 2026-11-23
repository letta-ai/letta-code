import vm from "node:vm";
import type { WorkflowMeta } from "./types.ts";

const META_PATTERN = /export\s+const\s+meta\s*=\s*\{/;

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
  let comment: "line" | "block" | null = null;
  for (let i = start; i < script.length; i++) {
    const ch = script[i];
    if (comment === "line") {
      if (ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029") {
        comment = null;
      }
      continue;
    }
    if (comment === "block") {
      if (ch === "*" && script[i + 1] === "/") {
        comment = null;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "/" && (script[i + 1] === "/" || script[i + 1] === "*")) {
      comment = script[i + 1] === "/" ? "line" : "block";
      i++;
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

export function parseWorkflowMeta(script: string): WorkflowMeta {
  const { literal } = extractMetaLiteral(script);
  let parsed: unknown;
  try {
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

export function stripMetaExport(script: string): string {
  return script.replace(META_PATTERN, (m) => m.replace(/^export\s+/, ""));
}
