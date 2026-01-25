#!/usr/bin/env bun
/**
 * Latency Benchmark Script for Letta Code CLI
 *
 * Runs headless mode with LETTA_DEBUG_TIMINGS=1 and parses the output
 * to measure latency breakdown at different stages.
 *
 * Usage:
 *   bun scripts/latency-benchmark.ts
 *   bun scripts/latency-benchmark.ts --scenario fresh-agent
 *   bun scripts/latency-benchmark.ts --iterations 5
 *
 * Requires: LETTA_API_KEY environment variable
 */

import { spawn } from "node:child_process";

interface ApiCall {
  method: string;
  path: string;
  durationMs: number;
  status?: number;
}

interface Milestone {
  name: string;
  offsetMs: number;
}

interface BenchmarkResult {
  scenario: string;
  totalMs: number;
  milestones: Milestone[];
  apiCalls: ApiCall[];
  exitCode: number;
}

interface ScenarioConfig {
  name: string;
  description: string;
  args: string[];
}

// Define benchmark scenarios
const SCENARIOS: ScenarioConfig[] = [
  {
    name: "fresh-agent",
    description: "Create new agent and send simple prompt",
    args: [
      "-p",
      "What is 2+2? Reply with just the number.",
      "--new-agent",
      "--yolo",
      "--output-format",
      "json",
    ],
  },
  {
    name: "resume-agent",
    description: "Resume last agent and send simple prompt",
    args: [
      "-p",
      "What is 3+3? Reply with just the number.",
      "--continue",
      "--yolo",
      "--output-format",
      "json",
    ],
  },
  {
    name: "minimal-math",
    description: "Simple math question (no tool calls)",
    args: [
      "-p",
      "What is 5+5? Reply with just the number.",
      "--continue",
      "--yolo",
      "--output-format",
      "json",
    ],
  },
];

/**
 * Parse timing logs from stderr output
 */
function parseTimingLogs(stderr: string): {
  milestones: Milestone[];
  apiCalls: ApiCall[];
} {
  const milestones: Milestone[] = [];
  const apiCalls: ApiCall[] = [];

  const lines = stderr.split("\n");

  for (const line of lines) {
    // Parse milestones: [timing] MILESTONE CLI_START at +0ms (12:34:56.789)
    const milestoneMatch = line.match(
      /\[timing\] MILESTONE (\S+) at \+(\d+(?:\.\d+)?)(ms|s)/,
    );
    if (milestoneMatch) {
      const name = milestoneMatch[1]!;
      let offsetMs = parseFloat(milestoneMatch[2]!);
      if (milestoneMatch[3] === "s") {
        offsetMs *= 1000;
      }
      milestones.push({ name, offsetMs });
      continue;
    }

    // Parse API calls: [timing] GET /v1/agents/... -> 245ms (status: 200)
    const apiMatch = line.match(
      /\[timing\] (GET|POST|PUT|DELETE|PATCH) (\S+) -> (\d+(?:\.\d+)?)(ms|s)(?: \(status: (\d+)\))?/,
    );
    if (apiMatch) {
      const method = apiMatch[1]!;
      const path = apiMatch[2]!;
      let durationMs = parseFloat(apiMatch[3]!);
      if (apiMatch[4] === "s") {
        durationMs *= 1000;
      }
      const status = apiMatch[5] ? parseInt(apiMatch[5], 10) : undefined;
      apiCalls.push({ method, path, durationMs, status });
    }
  }

  return { milestones, apiCalls };
}

/**
 * Run a single benchmark scenario
 */
async function runBenchmark(scenario: ScenarioConfig): Promise<BenchmarkResult> {
  const start = performance.now();

  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", "dev", ...scenario.args], {
      env: { ...process.env, LETTA_DEBUG_TIMINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      const totalMs = performance.now() - start;
      const { milestones, apiCalls } = parseTimingLogs(stderr);

      resolve({
        scenario: scenario.name,
        totalMs,
        milestones,
        apiCalls,
        exitCode: code ?? 1,
      });
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      proc.kill("SIGTERM");
    }, 120000);
  });
}

/**
 * Format duration for display
 */
function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Print benchmark results
 */
function printResults(results: BenchmarkResult[]): void {
  console.log("\n" + "=".repeat(70));
  console.log("LATENCY BENCHMARK RESULTS");
  console.log("=".repeat(70) + "\n");

  for (const result of results) {
    const scenario = SCENARIOS.find((s) => s.name === result.scenario);
    console.log(`Scenario: ${result.scenario}`);
    console.log(`  ${scenario?.description || ""}`);
    console.log(`  Exit code: ${result.exitCode}`);
    console.log(`  Total wall time: ${formatMs(result.totalMs)}`);
    console.log("");

    // Print milestones
    if (result.milestones.length > 0) {
      console.log("  Milestones:");
      let prevMs = 0;
      for (const milestone of result.milestones) {
        const delta = milestone.offsetMs - prevMs;
        const deltaStr = prevMs === 0 ? "" : ` (+${formatMs(delta)})`;
        console.log(
          `    +${formatMs(milestone.offsetMs).padStart(8)} ${milestone.name}${deltaStr}`,
        );
        prevMs = milestone.offsetMs;
      }
      console.log("");
    }

    // Print API calls summary
    if (result.apiCalls.length > 0) {
      console.log("  API Calls:");
      const totalApiMs = result.apiCalls.reduce((sum, c) => sum + c.durationMs, 0);

      // Group by path pattern
      const grouped: Record<string, { count: number; totalMs: number }> = {};
      for (const call of result.apiCalls) {
        // Normalize paths (remove UUIDs)
        const normalizedPath = call.path.replace(
          /[a-f0-9-]{36}/g,
          "{id}",
        );
        const key = `${call.method} ${normalizedPath}`;
        if (!grouped[key]) {
          grouped[key] = { count: 0, totalMs: 0 };
        }
        grouped[key].count++;
        grouped[key].totalMs += call.durationMs;
      }

      // Sort by total time
      const sorted = Object.entries(grouped).sort(
        (a, b) => b[1].totalMs - a[1].totalMs,
      );

      for (const [endpoint, stats] of sorted) {
        const countStr = stats.count > 1 ? ` (x${stats.count})` : "";
        console.log(
          `    ${formatMs(stats.totalMs).padStart(8)} ${endpoint}${countStr}`,
        );
      }

      console.log(`    ${"─".repeat(50)}`);
      console.log(`    ${formatMs(totalApiMs).padStart(8)} Total API time`);
      console.log(
        `    ${formatMs(result.totalMs - totalApiMs).padStart(8)} CLI overhead (non-API)`,
      );
    }

    console.log("\n" + "-".repeat(70) + "\n");
  }

  // Summary table
  console.log("SUMMARY");
  console.log("-".repeat(70));
  console.log(
    "Scenario".padEnd(20) +
      "Total".padStart(12) +
      "API Time".padStart(12) +
      "CLI Overhead".padStart(14),
  );
  console.log("-".repeat(70));

  for (const result of results) {
    const totalApiMs = result.apiCalls.reduce((sum, c) => sum + c.durationMs, 0);
    const cliOverhead = result.totalMs - totalApiMs;
    console.log(
      result.scenario.padEnd(20) +
        formatMs(result.totalMs).padStart(12) +
        formatMs(totalApiMs).padStart(12) +
        formatMs(cliOverhead).padStart(14),
    );
  }
  console.log("-".repeat(70));
}

async function main(): Promise<void> {
  // Parse args
  const args = process.argv.slice(2);
  let scenarioFilter: string | null = null;
  let iterations = 1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scenario" && args[i + 1]) {
      scenarioFilter = args[++i]!;
    } else if (args[i] === "--iterations" && args[i + 1]) {
      iterations = parseInt(args[++i]!, 10);
    }
  }

  // Check prereqs
  if (!process.env.LETTA_API_KEY) {
    console.error("Error: LETTA_API_KEY environment variable is required");
    process.exit(1);
  }

  // Filter scenarios
  const scenariosToRun = scenarioFilter
    ? SCENARIOS.filter((s) => s.name === scenarioFilter)
    : SCENARIOS;

  if (scenariosToRun.length === 0) {
    console.error(`Error: Unknown scenario "${scenarioFilter}"`);
    console.error(`Available scenarios: ${SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  console.log("Running latency benchmarks...");
  console.log(`Scenarios: ${scenariosToRun.map((s) => s.name).join(", ")}`);
  console.log(`Iterations: ${iterations}`);
  console.log("");

  const allResults: BenchmarkResult[] = [];

  for (let iter = 0; iter < iterations; iter++) {
    if (iterations > 1) {
      console.log(`\n--- Iteration ${iter + 1} of ${iterations} ---`);
    }

    for (const scenario of scenariosToRun) {
      console.log(`Running: ${scenario.name}...`);
      const result = await runBenchmark(scenario);
      allResults.push(result);

      if (result.exitCode !== 0) {
        console.warn(`  Warning: ${scenario.name} exited with code ${result.exitCode}`);
      } else {
        console.log(`  Completed in ${formatMs(result.totalMs)}`);
      }
    }
  }

  printResults(allResults);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
