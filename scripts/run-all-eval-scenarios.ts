#!/usr/bin/env bun
/**
 * Run all configured evaluation.scenarios from the three learning envs.
 * Uses existing candidate mods with skipGeneration=true so only the eval phase runs.
 */
import { readModLearningEnv, runModLearning, defaultCommandRunner } from "@/mods/learning-harness";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const ENV_DIR = path.join(REPO_ROOT, "docs", "examples", "mods", "learning");

// Existing candidate mods from prior successful learning runs
const CANDIDATE_SOURCES: Record<string, string> = {
  "memory-citations": path.join(
    REPO_ROOT,
    ".letta/mod-learning-runs/memory-citations-2026-06-15T23-31-07-704Z/mods/memory-citations.ts",
  ),
  "three-way-code-commits": path.join(
    REPO_ROOT,
    ".letta/mod-learning-runs/three-way-code-commits-2026-06-15T23-38-49-109Z/mods/three-way-code-commits.ts",
  ),
  "uv-pip-install": path.join(
    REPO_ROOT,
    ".letta/mod-learning-runs/uv-pip-install-2026-06-15T23-24-27-541Z/mods/uv-pip-install.ts",
  ),
};

const envFiles = [
  "memory-citations.env.json",
  "three-way-code-commits.env.json",
  "uv-pip-install.env.json",
];

async function main() {
  const results: Array<{ env: string; passed: boolean; score: number; maxScore?: number }> = [];

  for (const envFile of envFiles) {
    const envPath = path.join(ENV_DIR, envFile);
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Loading env: ${envFile}`);
    const spec = await readModLearningEnv(envPath);
    const slug = spec.slug ?? spec.name;
    const candidateSource = CANDIDATE_SOURCES[slug];

    if (!candidateSource) {
      console.error(`  No candidate source found for "${slug}", skipping`);
      continue;
    }

    console.log(`  Spec: ${spec.name}`);
    console.log(`  Candidate: ${candidateSource}`);
    console.log(`  Scenarios: ${(spec.evaluation.scenarios ?? []).map((s) => s.name).join(", ") || "(default)"}`);

    const report = await runModLearning({
      candidateSourcePath: candidateSource,
      commandRunner: defaultCommandRunner,
      env: process.env as Record<string, string>,
      repoRoot: REPO_ROOT,
      skipGeneration: true,
      spec,
    });

    const result = {
      env: envFile,
      passed: report.passed,
      score: report.score ?? 0,
      maxScore: report.maxScore,
    };
    results.push(result);

    console.log(`  Result: ${report.passed ? "PASS" : "FAIL"} (score: ${result.score}/${result.maxScore ?? "?"})`);

    // Print per-scenario results
    if (report.evaluation.scenarioResults) {
      for (const scenario of report.evaluation.scenarioResults) {
        console.log(`    - ${scenario.name}: ${scenario.passed ? "PASS" : "FAIL"}`);
        if (!scenario.passed) {
          for (const check of scenario.assertionChecks) {
            if (!check.passed) {
              console.log(`      ❌ ${check.label}: ${check.message}`);
            }
          }
          for (const check of scenario.requiredResultMarkers) {
            if (!check.present) console.log(`      ❌ Missing required result: ${check.marker}`);
          }
          for (const check of scenario.requiredTraceMarkers) {
            if (!check.present) console.log(`      ❌ Missing required trace: ${check.marker}`);
          }
          for (const check of scenario.forbiddenResultMarkers) {
            if (check.present) console.log(`      ❌ Present forbidden result: ${check.marker}`);
          }
          for (const check of scenario.forbiddenTraceMarkers) {
            if (check.present) console.log(`      ❌ Present forbidden trace: ${check.marker}`);
          }
        }
      }
    }
    console.log(`  Artifacts: ${report.runDir}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(60)}`);
  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`  ${status} ${r.env} (${r.score}/${r.maxScore ?? "?"})`);
    if (!r.passed) allPassed = false;
  }
  console.log(`\nOverall: ${allPassed ? "ALL PASSED" : "SOME FAILED"}`);

  if (!allPassed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
