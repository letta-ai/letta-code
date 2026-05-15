/**
 * Renders a GitHub issue body summarizing a Codex release's impact on the
 * letta-code harness.
 */

import type { ModelsDiff, Verdict } from "./diff-models-json.ts";

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

  // Release notes
  parts.push(`<details><summary>Release notes</summary>`);
  parts.push("");
  parts.push(input.release_notes_md || "_(empty)_");
  parts.push("");
  parts.push(`</details>`);
  parts.push("");

  // Suggested actions
  parts.push(`## Suggested actions`);
  parts.push("");
  for (const a of suggestedActions(input)) parts.push(`- [ ] ${a}`);
  parts.push("");

  // Provenance
  parts.push(`## How this was generated`);
  parts.push("");
  parts.push(`- Release: ${input.release_url}`);
  parts.push(
    `- Compare: https://github.com/openai/codex/compare/${input.previous_tag}...${input.current_tag}`,
  );
  parts.push(`- Workflow run: ${input.workflow_run_url}`);

  return parts.join("\n");
}

function verdictRationale(input: RenderInput): string {
  switch (input.verdict) {
    case "no-op":
      return "No tool-relevant changes detected in watched paths. Filed for audit trail.";
    case "prompt-only update":
      return "Prompt text or tool mentions changed. `src/agent/prompts/source_codex.md` should be re-extracted; no tool implementation changes needed.";
    case "tool-schema update needed":
      return "Upstream changed tool-config fields in `models.json`. Review the table below and update the matching letta-code tool schema, description, implementation, or prompt mirror if the new model contract diverges.";
    case "tool-surface review needed":
      return "No tool-config field deltas were detected in `models.json`, but upstream changed watched tool implementation paths. Review the commits below to decide whether letta-code needs matching tool schema, prompt, or behavior updates.";
    case "manual review required":
      return "Could not classify automatically (parse error or removed model). Please review the diff manually.";
  }
}

function hasPath(input: RenderInput, prefix: string): boolean {
  return input.path_changes.some((p) => p.path.startsWith(prefix));
}

function potentialImpacts(input: RenderInput): string[] {
  const out: string[] = [];

  if (input.models_diff?.field_deltas.length) {
    out.push(
      "`models.json` changed tool-related model fields. Use the table above to update the listed local mirror paths if the field controls tool naming, availability, or prompt instructions in letta-code.",
    );
  }

  if (hasPath(input, "codex-rs/core/src/tools")) {
    out.push(
      "`codex-rs/core/src/tools` changed. Check whether upstream changed built-in tool specs or runtime semantics, then compare against `src/tools/toolDefinitions.ts`, `src/tools/schemas/*.json`, `src/tools/descriptions/*.md`, `src/tools/impl/*`, and `src/tools/manager.ts`.",
    );
    out.push(
      "Map commit subjects to local tools before editing: `view_image` maps to `ViewImage`, shell/exec changes map to `ShellCommand`/`Bash`, `apply_patch` changes map to `ApplyPatch`, and MCP/search/approval changes may be upstream-only if letta-code has no equivalent exposed tool.",
    );
  }

  if (hasPath(input, "codex-rs/apply-patch")) {
    out.push(
      "`codex-rs/apply-patch` changed. Compare parser and failure semantics with `src/tools/impl/ApplyPatch.ts`, `src/tools/impl/MemoryApplyPatch.ts`, `src/tools/descriptions/ApplyPatch.md`, and the apply-patch tests.",
    );
  }

  if (input.prompt_md_changed) {
    out.push(
      "`codex-rs/models-manager/prompt.md` changed. Re-extract or reconcile `src/agent/prompts/source_codex.md` and update `src/agent/prompts/README.md` provenance.",
    );
  }

  if (input.verdict === "no-op") {
    out.push(
      "No watched tool surfaces changed. Skim release notes for untracked harness risks, then close if nothing applies.",
    );
  }

  return out;
}

function suggestedActions(input: RenderInput): string[] {
  const out: string[] = [];
  if (input.verdict === "no-op") {
    out.push("Skim the release notes; close this issue if nothing stands out.");
    return out;
  }
  if (input.verdict === "prompt-only update" || input.prompt_md_changed) {
    out.push(
      "Re-extract `src/agent/prompts/source_codex.md` from upstream `codex-rs/models-manager/models.json` (`instructions_template` with `personality_pragmatic`).",
    );
    out.push("Update provenance line in `src/agent/prompts/README.md`.");
  }
  if (input.verdict === "tool-schema update needed") {
    out.push(
      "For each `models.json` row above, inspect the listed local mirror path and update letta-code only if the new field value changes the exposed tool contract.",
    );
    out.push(
      "If a schema/description/implementation changes, add or update the matching test under `src/tests/tools/`.",
    );
  }
  if (input.verdict === "tool-surface review needed") {
    out.push(
      "Review the upstream commits under watched paths and decide whether each one has a letta-code mirror or is upstream-only.",
    );
    out.push(
      "If letta-code should mirror a change, update the relevant `src/tools/schemas`, `src/tools/descriptions`, `src/tools/impl`, prompt source, and tests together.",
    );
  }
  if (input.verdict === "manual review required") {
    out.push(
      "Diff `openai/codex` between the two tags manually and decide whether letta-code needs to react.",
    );
  }
  return out;
}
