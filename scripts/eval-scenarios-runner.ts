import { readModLearningEnv, runModLearning } from "@/mods/learning-harness";
import path from "node:path";

const envPath = process.argv[2];
const candidatePath = process.argv[3];
const repoRoot = process.cwd();

if (!envPath || !candidatePath) {
  console.error("Usage: bun run eval-scenarios-runner.ts <env.json> <candidate.ts>");
  process.exit(1);
}

async function main() {
  const spec = await readModLearningEnv(path.resolve(repoRoot, envPath));
  const resolvedCandidate = path.resolve(repoRoot, candidatePath);

  const report = await runModLearning({
    candidateSourcePath: resolvedCandidate,
    skipGeneration: true,
    spec,
    repoRoot,
    candidateFileName: path.basename(resolvedCandidate),
  });

  console.log("\n=== EVALUATION RESULTS ===\n");
  console.log(`Score: ${report.score ?? 0}/${report.maxScore ?? "?"}`);
  console.log(`Passed: ${report.passed}`);
  console.log(`Candidate: ${report.candidatePath}`);

  if (report.evaluation.scenarioResults) {
    for (const scenario of report.evaluation.scenarioResults) {
      console.log(`\n--- Scenario: ${scenario.name} ---`);
      console.log(`  Passed: ${scenario.passed}`);
      for (const check of scenario.assertionChecks) {
        console.log(`  ${check.passed ? "✅" : "❌"} ${check.label}: ${check.message}`);
        if (check.details) {
          for (const [key, value] of Object.entries(check.details)) {
            console.log(`    ${key}: ${JSON.stringify(value)}`);
          }
        }
      }
      if (scenario.requiredResultMarkers.length) {
        console.log("  Required result markers:");
        for (const m of scenario.requiredResultMarkers) {
          console.log(`    ${m.present ? "✅" : "❌"} ${m.marker}`);
        }
      }
      if (scenario.forbiddenResultMarkers.length) {
        console.log("  Forbidden result markers:");
        for (const m of scenario.forbiddenResultMarkers) {
          console.log(`    ${m.present ? "❌" : "✅"} ${m.marker}`);
        }
      }
    }
  } else {
    console.log("\n--- Single scenario evaluation ---");
    for (const check of report.evaluation.assertionChecks) {
      console.log(`  ${check.passed ? "✅" : "❌"} ${check.label}: ${check.message}`);
      if (check.details) {
        for (const [key, value] of Object.entries(check.details)) {
          console.log(`    ${key}: ${JSON.stringify(value)}`);
        }
      }
    }
  }

  console.log(`\nRun directory: ${report.runDir}`);
  console.log(`Report: ${report.reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
