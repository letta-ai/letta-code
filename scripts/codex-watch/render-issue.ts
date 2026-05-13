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
  ],
  web_search_tool_type: ["src/tools/impl/"],
  shell_type: ["src/tools/impl/", "src/agent/prompts/source_codex.md"],
  supports_search_tool: ["src/tools/impl/"],
  supports_parallel_tool_calls: ["src/agent/prompts/source_codex.md"],
  experimental_supported_tools: [
    "src/tools/toolDefinitions.ts",
    "src/tools/impl/",
  ],
  input_modalities: ["src/tools/impl/"],
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
      return "Upstream changed tool-config fields in `models.json` and/or `codex-rs/core/src/tools/`. Letta-code's tool definitions may need to mirror the new shape.";
    case "manual review required":
      return "Could not classify automatically (parse error or removed model). Please review the diff manually.";
  }
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
      "Inspect changed fields above and update matching tool definitions under `src/tools/` if behavior diverges.",
    );
    out.push(
      "Check `src/tools/toolDefinitions.ts` for any tool whose schema should mirror an upstream change.",
    );
  }
  if (input.verdict === "manual review required") {
    out.push(
      "Diff `openai/codex` between the two tags manually and decide whether letta-code needs to react.",
    );
  }
  return out;
}
