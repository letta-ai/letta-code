/**
 * Renders a GitHub issue body summarizing a Codex release's impact on the
 * letta-code harness.
 */

import type { ModelsDiff, Verdict } from "./diff-models-json.ts";

const ACTION_REVIEWER = "@kl2806";

export interface PathChangeSummary {
  path: string;
  /** One-line commit subjects under this path between the two refs. */
  commits: string[];
}

export interface RenderInput {
  previous_tag: string;
  current_tag: string;
  release_url: string;
  release_notes_md: string;
  verdict: Verdict;
  models_diff: ModelsDiff | null;
  prompt_md_changed: boolean;
  prompt_md_diff_preview: string | null;
  path_changes: PathChangeSummary[];
  workflow_run_url: string;
}

/** Mapping from upstream concept to local letta-code file(s) to inspect. */
const LOCAL_MIRRORS: Record<string, string[]> = {
  apply_patch_tool_type: [
    "src/agent/prompts/source_codex.md",
    "src/tools/impl/",
    "src/tools/schemas/ApplyPatch.json",
    "src/tools/descriptions/ApplyPatch.md",
  ],
  web_search_tool_type: ["src/tools/toolDefinitions.ts", "src/tools/impl/"],
  shell_type: [
    "src/tools/toolDefinitions.ts",
    "src/tools/schemas/ShellCommand.json",
    "src/tools/descriptions/ShellCommand.md",
    "src/tools/impl/",
    "src/agent/prompts/source_codex.md",
  ],
  supports_search_tool: ["src/tools/filter.ts", "src/tools/toolDefinitions.ts"],
  supports_parallel_tool_calls: ["src/agent/prompts/source_codex.md"],
  experimental_supported_tools: [
    "src/tools/toolDefinitions.ts",
    "src/tools/schemas/",
    "src/tools/descriptions/",
    "src/tools/impl/",
  ],
  input_modalities: ["src/tools/toolDefinitions.ts", "src/tools/impl/"],
  truncation_policy: ["src/agent/prompts/source_codex.md"],
  prompt_tool_mentions: ["src/agent/prompts/source_codex.md"],
};

function localMirror(field: string): string {
  const mirrors = LOCAL_MIRRORS[field];
  if (!mirrors || mirrors.length === 0) return "—";
  return mirrors.join(", ");
}

function fmtVal(v: unknown): string {
  if (v === undefined) return "_(unset)_";
  if (v === null) return "`null`";
  const s = JSON.stringify(v);
  return s.length > 80 ? `\`${s.slice(0, 77)}...\`` : `\`${s}\``;
}

export function renderTitle(input: RenderInput): string {
  return `[codex-watch] openai/codex ${input.current_tag} — ${input.verdict}`;
}

export function renderBody(input: RenderInput): string {
  const parts: string[] = [];

  // Verdict
  parts.push(`## Verdict`);
  parts.push("");
  parts.push(`**${input.verdict}**`);
  parts.push("");
  parts.push(verdictRationale(input));
  parts.push("");
  if (needsReviewerAttention(input)) {
    parts.push(`Reviewer: ${ACTION_REVIEWER}`);
    parts.push("");
  }

  // Tool / schema deltas
  parts.push(`## Tool / schema deltas`);
  parts.push("");
  if (
    input.models_diff &&
    (input.models_diff.field_deltas.length > 0 ||
      input.models_diff.added_models.length > 0 ||
      input.models_diff.removed_models.length > 0)
  ) {
    if (input.models_diff.added_models.length > 0) {
      parts.push(
        `**Added models:** ${input.models_diff.added_models.map((s) => `\`${s}\``).join(", ")}`,
      );
      parts.push("");
    }
    if (input.models_diff.removed_models.length > 0) {
      parts.push(
        `**Removed models:** ${input.models_diff.removed_models.map((s) => `\`${s}\``).join(", ")}`,
      );
      parts.push("");
    }
    if (input.models_diff.field_deltas.length > 0) {
      parts.push(
        "| Model | Field | Previous | New | Affected letta-code path |",
      );
      parts.push(
        "|-------|-------|----------|-----|--------------------------|",
      );
      for (const d of input.models_diff.field_deltas) {
        parts.push(
          `| \`${d.slug}\` | \`${d.field}\` | ${fmtVal(d.previous)} | ${fmtVal(d.current)} | ${localMirror(d.field)} |`,
        );
      }
      parts.push("");
    }
  } else {
    parts.push("_No tool-field deltas detected in `models.json`._");
    parts.push("");
  }

  // Upstream changes by path
  parts.push(`## Upstream changes by path`);
  parts.push("");
  if (input.path_changes.length > 0) {
    for (const p of input.path_changes) {
      parts.push(`### \`${p.path}\``);
      if (p.commits.length === 0) {
        parts.push("_No commits touching this path between releases._");
      } else {
        for (const c of p.commits) parts.push(`- ${c}`);
      }
      parts.push("");
    }
  } else {
    parts.push("_No changes under watched paths._");
    parts.push("");
  }

  const impacts = potentialImpacts(input);
  if (impacts.length > 0) {
    parts.push(`## Potential letta-code impact`);
    parts.push("");
    for (const impact of impacts) parts.push(`- ${impact}`);
    parts.push("");
  }

  // Prompt diff preview
  if (input.prompt_md_changed && input.prompt_md_diff_preview) {
    parts.push(`## \`codex-rs/models-manager/prompt.md\` diff (preview)`);
    parts.push("");
    parts.push("```diff");
    parts.push(input.prompt_md_diff_preview);
    parts.push("```");
    parts.push("");
  }

  // Suggested actions
  parts.push(`## Suggested actions`);
  parts.push("");
  for (const a of suggestedActions(input)) parts.push(`- [ ] ${a}`);
  parts.push("");

  // Provenance
  parts.push(`## How this was generated`);
  parts.push("");
  parts.push(`- Release/notes: ${input.release_url}`);
  parts.push(
    `- Compare: https://github.com/openai/codex/compare/${input.previous_tag}...${input.current_tag}`,
  );
  parts.push(`- Workflow run: ${input.workflow_run_url}`);

  return parts.join("\n");
}

function needsReviewerAttention(input: RenderInput): boolean {
  return input.verdict !== "no-op";
}

function verdictRationale(input: RenderInput): string {
  switch (input.verdict) {
    case "no-op":
      return "No watched tool-surface changes detected.";
    case "prompt-only update":
      return "Prompt text or tool mentions changed; `src/agent/prompts/source_codex.md` may need re-extraction.";
    case "tool-schema update needed":
      return "Upstream changed tool-config fields in `models.json`. Review local mirrors only where the model contract changed.";
    case "tool-surface review needed":
      return "No `models.json` tool-field deltas, but upstream tool implementation paths changed. Check whether letta-code has a mirror.";
    case "manual review required":
      return "Could not classify automatically; review the upstream diff manually.";
  }
}

function hasPath(input: RenderInput, prefix: string): boolean {
  return input.path_changes.some((p) => p.path.startsWith(prefix));
}

function potentialImpacts(input: RenderInput): string[] {
  const out: string[] = [];

  if (input.models_diff?.field_deltas.length) {
    out.push(
      "`models.json` field deltas: inspect listed local mirrors for schema, availability, or prompt drift.",
    );
  }

  if (hasPath(input, "codex-rs/core/src/tools")) {
    out.push(
      "Core tools changed: compare relevant commits against `src/tools/toolDefinitions.ts`, `schemas/`, `descriptions/`, `impl/`, and `manager.ts`.",
    );
    out.push(
      "Likely mirrors: `view_image` → `ViewImage`, shell/exec → `ShellCommand`/`Bash`, `apply_patch` → `ApplyPatch`; MCP/search/approval may be upstream-only.",
    );
  }

  if (hasPath(input, "codex-rs/apply-patch")) {
    out.push(
      "`apply-patch` changed: compare parser/failure semantics with `ApplyPatch.ts`, `MemoryApplyPatch.ts`, descriptions, and tests.",
    );
  }

  if (input.prompt_md_changed) {
    out.push(
      "Prompt changed: reconcile `src/agent/prompts/source_codex.md` and README provenance.",
    );
  }

  if (input.verdict === "no-op") {
    out.push(
      "No watched tool surfaces changed. Skim release notes, then close if nothing applies.",
    );
  }

  return out;
}

function suggestedActions(input: RenderInput): string[] {
  const out: string[] = [];
  if (input.verdict === "no-op") {
    out.push("Skim release notes; close if nothing stands out.");
    return out;
  }
  if (input.verdict === "prompt-only update" || input.prompt_md_changed) {
    out.push(
      "Re-extract/reconcile `src/agent/prompts/source_codex.md` if prompt semantics changed.",
    );
  }
  if (input.verdict === "tool-schema update needed") {
    out.push(
      "Inspect each `models.json` delta; update local schema/description/impl/tests only if the exposed contract changed.",
    );
  }
  if (input.verdict === "tool-surface review needed") {
    out.push(
      "Review watched-path commits; if a change has a letta-code mirror, update schema/description/impl/prompt/tests together.",
    );
  }
  if (input.verdict === "manual review required") {
    out.push(
      "Diff `openai/codex` between the two tags manually and decide whether letta-code needs to react.",
    );
  }
  return out;
}
