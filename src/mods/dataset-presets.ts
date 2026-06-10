import path from "node:path";
import {
  type ModLearningDatasetConfig,
  normalizeDatasetTaskIds,
} from "@/mods/dataset-adapter";
import type { ModLearningSpec } from "@/mods/learning-harness";

export interface BuiltInDatasetLearningOptions {
  adapterCommand?: string;
  dataset: string;
  repoRoot: string;
  subset?: string;
  taskIds?: string[];
  trials?: number;
}

export function builtInDatasetLearningEnv(
  dataset: string,
  subset?: string,
): ModLearningSpec | null {
  if (dataset !== "terminalbench") return null;
  const subsetLabel = subset ?? "smoke";
  return {
    name: `TerminalBench mod learner (${subsetLabel})`,
    slug: `terminalbench-${subsetLabel}`,
    objective:
      "Learn a normal Letta Code mod that improves agent performance on TerminalBench-style terminal tasks.",
    requirements: [
      "Stay within the normal trusted local mod API; do not patch Letta Code or the benchmark runner.",
      "Improve long-horizon terminal task behavior by adding reusable guidance, tools, lifecycle hooks, or diagnostics.",
      "Avoid hard-coding task-specific solution strings, filenames, or benchmark answers.",
      "Keep the mod small enough to inspect and safe to load through the host-filesystem adapter contract.",
    ],
    candidateDiversityHints: [
      "Focus on environment bootstrapping and early situational awareness.",
      "Focus on reducing repeated failing shell commands and adding concise recovery guidance.",
      "Focus on task completion discipline, artifact checks, and avoiding premature DONE responses.",
    ],
    modApiHints: [
      "Use turn_start hooks for lightweight persistent guidance when available.",
      "Use tool_start hooks for diagnostics or argument normalization only when they are broadly safe.",
      "If registering tools, keep them read-only, approval-free, and useful across tasks rather than tied to one benchmark item.",
    ],
    evaluation: {
      outputFormat: "stream-json",
      prompt: `Dataset-backed evaluation is handled by a host-filesystem TerminalBench adapter on the ${subsetLabel} subset. Optimize for higher task pass rate, then lower cost and timeout rate. The adapter writes score.json, per-task report.md files, and raw trajectories into each candidate directory for future candidates to inspect. Sandboxed mod mounting is out of scope for this learner path.`,
    },
  };
}

export function builtInDatasetAdapterConfig(
  options: BuiltInDatasetLearningOptions,
): ModLearningDatasetConfig {
  if (options.dataset !== "terminalbench") {
    throw new Error(`Unknown dataset adapter: ${options.dataset}`);
  }

  const adapterScript = path.join(
    options.repoRoot,
    "scripts",
    "mod-learning",
    "dataset-adapters",
    "terminalbench.ts",
  );
  const taskIds = normalizeDatasetTaskIds(options.taskIds);
  return {
    adapter: options.adapterCommand
      ? { command: options.adapterCommand }
      : { args: [adapterScript], command: "bun" },
    dataset: "terminalbench",
    subset: options.subset ?? "smoke",
    taskIds:
      taskIds && taskIds.length > 0
        ? taskIds
        : options.subset === undefined || options.subset === "smoke"
          ? ["extract-elf"]
          : undefined,
    trials: options.trials ?? 1,
  };
}
