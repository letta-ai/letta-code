// On-disk layout for dream pipeline runs.
//
// Everything lives under the agent's reflection-transcript root in a
// dot-prefixed directory so the conversation scan in reflection-transcript.ts
// (which treats child directories as conversation ids) never picks it up:
//
//   {transcriptRoot}/{agentId}/.dream/
//     reflector.json / aggregator.json     — persistent worker agent state
//     runs/{runId}/
//       manifest.json                      — run config, selection, batches, results
//       batches/{index}/                   — self-contained per reflection agent:
//         input/{harness}-{sessionId}.json — the batch's normalized-v1 transcripts
//         output/                          — fresh memfs git repo the batch agent writes
//         trajectory.json                  — the agent's own run, normalized-v1
//         report.json                      — batch outcome (commits, errors, subagent report)
//       aggregate/
//         output/ + memfs.patch            — snapshot of the aggregator's final tree
//         trajectory.json                  — the aggregator's run, normalized-v1
//         report.json                      — aggregation outcome + final report

import { join } from "node:path";
import { getDreamRootDir } from "@/utils/transcript-paths";

export { getDreamRootDir } from "@/utils/transcript-paths";

export function getDreamRunRoot(agentId: string, runId: string): string {
  return join(getDreamRootDir(agentId), "runs", runId);
}

export function getDreamBatchDir(runRoot: string, batchIndex: number): string {
  return join(runRoot, "batches", String(batchIndex));
}

export function getDreamAggregateDir(runRoot: string): string {
  return join(runRoot, "aggregate");
}

/** Filesystem-safe file name for one normalized session. */
export function normalizedSessionFileName(
  harness: string,
  sessionId: string,
): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${safe(harness)}-${safe(sessionId)}.json`;
}

export function newDreamRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const nonce = Math.random().toString(36).slice(2, 8);
  return `dream-${stamp}-${nonce}`;
}
