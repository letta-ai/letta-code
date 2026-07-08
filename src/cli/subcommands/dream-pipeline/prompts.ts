// Prompt loading + templating for the dream pipeline's subagents. Both run on
// the builtin `reflection` subagent (Bash + Edit, $MEMORY_DIR env contract,
// Phase 1-5 memory-formation system prompt); the user prompts here retarget
// that machinery at batch inputs. Keep prompt TEXT in prompts/*.md — the .md
// files are the editing surface; this module only interpolates {{vars}}.
// render() throws on unresolved {{vars}} so a renamed placeholder fails at
// run start instead of leaking into a prompt.

import aggregatorUserMd from "./prompts/aggregator-user.md";
import reflectionUserMd from "./prompts/reflection-user.md";

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

/** One reflection agent's directory, listed inline in the aggregator prompt. */
export interface AggregationInput {
  label: string;
  /** The batch directory: contains output/, report.json, trajectory.json, input/. */
  dir: string;
  timeRange?: { start: string; end: string };
  sessionCount?: number;
}

function describeAggregationInput(entry: AggregationInput): string {
  const details: string[] = [];
  if (entry.timeRange) {
    details.push(`${entry.timeRange.start} → ${entry.timeRange.end}`);
  }
  if (entry.sessionCount !== undefined) {
    details.push(`${entry.sessionCount} session(s)`);
  }
  return `- ${entry.dir}${details.length ? `  (${details.join(", ")})` : ""}`;
}

export function buildAggregationPrompt(input: {
  inputs: AggregationInput[];
  instruction?: string;
}): string {
  return render(aggregatorUserMd, {
    count: input.inputs.length,
    dirList: input.inputs.map(describeAggregationInput).join("\n"),
    instructionSection: instructionSection(input.instruction),
  });
}
