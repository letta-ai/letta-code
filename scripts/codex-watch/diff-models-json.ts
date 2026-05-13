/**
 * Structured diff of openai/codex `codex-rs/models-manager/models.json`.
 *
 * We don't care about every field — only the ones that affect the tool/schema
 * surface exposed to the model. When any of these change, the letta-code
 * harness (src/agent/prompts/source_codex.md and src/tools/*) may need updating.
 */

/** Tool-relevant fields lifted off each model entry in models.json. */
export interface ModelToolConfig {
  slug: string;
  apply_patch_tool_type?: string;
  web_search_tool_type?: string;
  shell_type?: string;
  supports_search_tool?: boolean;
  supports_parallel_tool_calls?: boolean;
  supports_image_detail_original?: boolean;
  experimental_supported_tools?: string[];
  input_modalities?: string[];
  truncation_policy?: unknown;
  /** Tool names mentioned anywhere in base_instructions / instructions_template. */
  prompt_tool_mentions: string[];
}

/** Substrings we treat as "this prompt mentions tool X". */
const TOOL_MENTIONS = [
  "apply_patch",
  "exec_command",
  "view_image",
  "multi_tool_use.parallel",
  "web_search",
  "update_plan",
  "container.exec",
];

export interface ModelsJson {
  models: Array<Record<string, unknown>>;
}

export interface ToolFieldDelta {
  slug: string;
  field: string;
  previous: unknown;
  current: unknown;
}

export interface ModelsDiff {
  added_models: string[];
  removed_models: string[];
  field_deltas: ToolFieldDelta[];
  /** True if any field_delta is in TOOL_SCHEMA_FIELDS. */
  has_tool_schema_change: boolean;
  /** True if any prompt_tool_mentions added or removed. */
  has_prompt_tool_change: boolean;
}

/** Fields whose change implies a tool-schema update may be needed in letta-code. */
export const TOOL_SCHEMA_FIELDS = new Set([
  "apply_patch_tool_type",
  "web_search_tool_type",
  "shell_type",
  "supports_search_tool",
  "supports_parallel_tool_calls",
  "experimental_supported_tools",
  "input_modalities",
  "truncation_policy",
]);

function collectMentions(text: string): string[] {
  const found = new Set<string>();
  for (const m of TOOL_MENTIONS) {
    if (text.includes(m)) found.add(m);
  }
  return Array.from(found).sort();
}

export function extractToolConfig(
  model: Record<string, unknown>,
): ModelToolConfig {
  const slug = typeof model.slug === "string" ? model.slug : "<unknown>";
  const promptText = [
    typeof model.base_instructions === "string" ? model.base_instructions : "",
    typeof model.model_messages === "object" && model.model_messages !== null
      ? JSON.stringify(model.model_messages)
      : "",
  ].join("\n");
  return {
    slug,
    apply_patch_tool_type: model.apply_patch_tool_type as string | undefined,
    web_search_tool_type: model.web_search_tool_type as string | undefined,
    shell_type: model.shell_type as string | undefined,
    supports_search_tool: model.supports_search_tool as boolean | undefined,
    supports_parallel_tool_calls: model.supports_parallel_tool_calls as
      | boolean
      | undefined,
    supports_image_detail_original: model.supports_image_detail_original as
      | boolean
      | undefined,
    experimental_supported_tools: model.experimental_supported_tools as
      | string[]
      | undefined,
    input_modalities: model.input_modalities as string[] | undefined,
    truncation_policy: model.truncation_policy,
    prompt_tool_mentions: collectMentions(promptText),
  };
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Compute the diff between two models.json payloads. */
export function diffModelsJson(prev: ModelsJson, curr: ModelsJson): ModelsDiff {
  const prevBySlug = new Map<string, ModelToolConfig>();
  const currBySlug = new Map<string, ModelToolConfig>();
  for (const m of prev.models) {
    const cfg = extractToolConfig(m);
    prevBySlug.set(cfg.slug, cfg);
  }
  for (const m of curr.models) {
    const cfg = extractToolConfig(m);
    currBySlug.set(cfg.slug, cfg);
  }

  const added_models: string[] = [];
  const removed_models: string[] = [];
  for (const slug of currBySlug.keys()) {
    if (!prevBySlug.has(slug)) added_models.push(slug);
  }
  for (const slug of prevBySlug.keys()) {
    if (!currBySlug.has(slug)) removed_models.push(slug);
  }

  const field_deltas: ToolFieldDelta[] = [];
  let has_tool_schema_change = false;
  let has_prompt_tool_change = false;

  const fieldsToCompare = [
    ...TOOL_SCHEMA_FIELDS,
    "supports_image_detail_original",
    "prompt_tool_mentions",
  ];

  for (const [slug, prevCfg] of prevBySlug) {
    const currCfg = currBySlug.get(slug);
    if (!currCfg) continue;
    for (const field of fieldsToCompare) {
      const p = (prevCfg as unknown as Record<string, unknown>)[field];
      const c = (currCfg as unknown as Record<string, unknown>)[field];
      if (!equal(p, c)) {
        field_deltas.push({ slug, field, previous: p, current: c });
        if (TOOL_SCHEMA_FIELDS.has(field)) has_tool_schema_change = true;
        if (field === "prompt_tool_mentions") has_prompt_tool_change = true;
      }
    }
  }

  return {
    added_models,
    removed_models,
    field_deltas,
    has_tool_schema_change,
    has_prompt_tool_change,
  };
}

export type Verdict =
  | "no-op"
  | "prompt-only update"
  | "tool-schema update needed"
  | "manual review required";

export interface VerdictInput {
  models_diff: ModelsDiff | null;
  prompt_md_changed: boolean;
  tools_dir_changed: boolean;
  apply_patch_dir_changed: boolean;
  parse_error: boolean;
}

/** Decide which verdict best describes the upstream change set. */
export function decideVerdict(input: VerdictInput): Verdict {
  if (input.parse_error) return "manual review required";
  if (!input.models_diff) return "manual review required";

  const removedModels = input.models_diff.removed_models.length > 0;
  if (removedModels) return "manual review required";

  if (
    input.models_diff.has_tool_schema_change ||
    input.tools_dir_changed ||
    input.apply_patch_dir_changed
  ) {
    return "tool-schema update needed";
  }

  if (input.models_diff.has_prompt_tool_change || input.prompt_md_changed) {
    return "prompt-only update";
  }

  if (input.models_diff.field_deltas.length > 0) {
    return "prompt-only update";
  }

  return "no-op";
}
