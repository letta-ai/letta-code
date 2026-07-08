// Prompt loading + templating for the dream pipeline's subagents. Both run on
// the builtin `reflection` subagent (Bash + Edit, $MEMORY_DIR env contract,
// Phase 1-5 memory-formation system prompt); the user prompts here retarget
// that machinery at batch inputs. Keep prompt TEXT in prompts/*.md — the .md
// files are the editing surface; this module only interpolates {{vars}}.
// render() throws on unresolved {{vars}} so a renamed placeholder fails at
// run start instead of leaking into a prompt.

import aggregatorPersonaMd from "./prompts/aggregator-persona.md";
import aggregatorUserMd from "./prompts/aggregator-user.md";
import reflectionUserMd from "./prompts/reflection-user.md";

/** Persona block for the persistent aggregator agent (default system prompt). */
export const AGGREGATOR_PERSONA: string = aggregatorPersonaMd.trim();

function render(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template
    .replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      const value = vars[key];
      if (value === undefined) {
        throw new Error(`prompt template: missing variable ${match}`);
      }
      return String(value);
    })
    .trim();
}

function instructionSection(instruction: string | undefined): string {
  return instruction?.trim()
    ? `\n\nAdditional user-provided instruction for this pass:\n${instruction.trim()}`
    : "";
}

export function buildBatchReflectionPrompt(input: {
  batchIndex: number;
  inputDir: string;
  sessionFileNames: string[];
  timeRange: { start: string; end: string };
  instruction?: string;
}): string {
  return render(reflectionUserMd, {
    batchIndex: input.batchIndex,
    sessionCount: input.sessionFileNames.length,
    startTime: input.timeRange.start,
    endTime: input.timeRange.end,
    inputDir: input.inputDir,
    sessionList: input.sessionFileNames.map((name) => `- ${name}`).join("\n"),
    instructionSection: instructionSection(input.instruction),
  });
}

export function buildAggregationPrompt(input: {
  /** The run's batches/ directory; each numbered subdir is one reflection. */
  batchesDir: string;
  batchCount: number;
  instruction?: string;
}): string {
  return render(aggregatorUserMd, {
    count: input.batchCount,
    batchesDir: input.batchesDir,
    instructionSection: instructionSection(input.instruction),
  });
}
