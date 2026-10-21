/**
 * Structured diff of openai/codex `codex-rs/models-manager/models.json`.
 *
 * We watch two surfaces: tool/schema fields that affect the tool surface
 * exposed to the model (letta-code mirrors these in src/agent/prompts/source_codex.md
 * and src/tools/*), and model instruction content (base_instructions /
 * model_messages / instructions_template), whose behavioral guidance is worth
 * reviewing even when no local mirror changes.
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
  /** Tool names mentioned anywhere in the model instruction text. */
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
  /** Slugs of existing models whose instruction content changed. */
  instruction_content_deltas: string[];
  /** Added models that ship instruction content. */
  added_models_with_instructions: string[];
  /** True if any field_delta is in TOOL_SCHEMA_FIELDS. */
  has_tool_schema_change: boolean;
  /** True if any prompt_tool_mentions added or removed. */
  has_prompt_tool_change: boolean;
  /** True if any existing model's instruction content changed. */
  has_instruction_content_change: boolean;
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

function slugOf(model: Record<string, unknown>): string {
  return typeof model.slug === "string" ? model.slug : "<unknown>";
}

export function extractToolConfig(
  model: Record<string, unknown>,
): ModelToolConfig {
  const slug = slugOf(model);
  const promptText = extractInstructionText(model);
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

/**
 * Full model instruction text whose content we watch for behavioral prompt
 * changes (e.g. steering or user-input guidance), not just tool mentions.
 */
export function extractInstructionText(model: Record<string, unknown>): string {
  const parts = [
    typeof model.base_instructions === "string" ? model.base_instructions : "",
    typeof model.model_messages === "object" &&
    model.model_messages !== null &&
    Object.keys(model.model_messages).length > 0
      ? JSON.stringify(model.model_messages)
      : "",
    typeof model.instructions_template === "string"
      ? model.instructions_template
      : "",
  ];
  return parts.filter((part) => part.length > 0).join("\n");
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

  const prevInstructions = new Map<string, string>();
  const currInstructions = new Map<string, string>();
  for (const m of prev.models) {
    prevInstructions.set(slugOf(m), extractInstructionText(m));
  }
  for (const m of curr.models) {
    currInstructions.set(slugOf(m), extractInstructionText(m));
  }

  const instruction_content_deltas: string[] = [];
  for (const [slug, prevText] of prevInstructions) {
    const currText = currInstructions.get(slug);
    if (currText === undefined || prevText === currText) continue;
    instruction_content_deltas.push(slug);
  }

  const added_models_with_instructions = added_models.filter(
    (slug) => (currInstructions.get(slug) ?? "").length > 0,
  );

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
    instruction_content_deltas,
    added_models_with_instructions,
    has_tool_schema_change,
    has_prompt_tool_change,
    has_instruction_content_change: instruction_content_deltas.length > 0,
  };
}

export type Verdict =
  | "no-op"
  | "prompt-only update"
  | "tool-schema update needed"
  | "tool-surface review needed"
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

  if (input.models_diff.has_tool_schema_change) {
    return "tool-schema update needed";
  }

  if (input.tools_dir_changed || input.apply_patch_dir_changed) {
    return "tool-surface review needed";
  }

  if (
    input.models_diff.has_prompt_tool_change ||
    input.models_diff.has_instruction_content_change ||
    input.models_diff.added_models_with_instructions.length > 0 ||
    input.prompt_md_changed
  ) {
    return "prompt-only update";
  }

  if (input.models_diff.field_deltas.length > 0) {
    return "prompt-only update";
  }

  return "no-op";
}
