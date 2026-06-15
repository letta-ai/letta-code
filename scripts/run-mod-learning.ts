#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { runModLearning, type ModLearningSpec } from "./src/mods/learning-harness.js";

const ENV_FILES = [
  "docs/examples/mods/learning/uv-pip-install.env.json",
  "docs/examples/mods/learning/three-way-code-commits.env.json",
  "docs/examples/mods/learning/memory-citations.env.json",
];

async function readModLearningEnv(envPath: string): Promise<ModLearningSpec> {
  return JSON.parse(await readFile(envPath, "utf8")) as ModLearningSpec;
}

async function main() {
  const repoRoot = process.cwd();
  
  for (const envPath of ENV_FILES) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`Running mod learning for: ${envPath}`);
    console.log(`${"=".repeat(80)}\n`);
    
    try {
      const spec = await readModLearningEnv(envPath);
      console.log(`Name: ${spec.name}`);
      console.log(`Slug: ${spec.slug}`);
      console.log(`Target: ${spec.targetModName}`);
      console.log(`Scenarios: ${spec.evaluation.scenarios?.length ?? 1}`);
      console.log("");
      
      const result = await runModLearning({
        repoRoot,
        spec,
        cliCommand: "./letta.js",
        cliArgsPrefix: [],
        candidateCount: 1,
        onProgress: (progress) => {
          console.log(`[${progress.phase}] ${progress.message}`);
        },
      });
      
      console.log("\n--- Result ---");
      console.log(`Passed: ${result.passed}`);
      console.log(`Score: ${result.score}/${result.maxScore}`);
      console.log(`Report: ${result.reportPath}`);
      console.log(`Run dir: ${result.runDir}`);
      
      if (!result.passed) {
        console.log("\nEvaluation details:");
        console.log(JSON.stringify(result.evaluation, null, 2));
      }
    } catch (error) {
      console.error(`Error processing ${envPath}:`, error);
    }
  }
}

main().catch(console.error);
