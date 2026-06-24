import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { CommandHandle, CommandUpdate } from "@/cli/commands/runner";
import type { ModLearningReport } from "@/mods/learning-harness";
import {
  formatModLearningSummary,
  handleModsCommand,
  parseModsCommand,
  parseModsGenerateEnvCommand,
} from "./mods";

function createFakeCommandRunner() {
  const updates: Array<CommandUpdate & { input?: string }> = [];
  return {
    runner: {
      start(input: string, output: string): CommandHandle {
        updates.push({ input, output, phase: "running" });
        return {
          id: "cmd-1",
          input,
          update(update: CommandUpdate) {
            updates.push(update);
          },
          finish(output, success = true, dimOutput, preformatted) {
            updates.push({
              dimOutput,
              output,
              phase: "finished",
              preformatted,
              success,
            });
          },
          fail(output) {
            updates.push({ output, phase: "finished", success: false });
          },
        };
      },
    },
    updates,
  };
}

describe("/mods command", () => {
  test("parses /mods generate-env skill launcher", () => {
    const parsed = parseModsGenerateEnvCommand(
      "/mods generate-env create an env for a statusline mod",
    );

    expect(parsed).toEqual({
      args: "create an env for a statusline mod",
    });
  });

  test("does not treat /mod as a command", () => {
    expect(
      parseModsGenerateEnvCommand("/mod generate-env anything"),
    ).toBeNull();
  });

  test("parses built-in learn target with model options", () => {
    const parsed = parseModsCommand(
      "/mods learn memory-citations --model current --backend api --candidate-file-name learned.ts",
      "anthropic/claude-sonnet-4",
    );

    expect(parsed?.command).toBe("learn");
    if (parsed?.command !== "learn") return;
    expect(parsed.learn.targetLabel).toBe("memory-citations");
    expect(parsed.learn.options.model).toBe("anthropic/claude-sonnet-4");
    expect(parsed.learn.options.backend).toBe("api");
    expect(parsed.learn.options.candidateFileName).toBe("learned.ts");
    expect(parsed.learn.env?.name).toContain("Memory citation");
  });

  test("rejects unknown learning targets", () => {
    const parsed = parseModsCommand("/mods learn unknown-target");
    expect(parsed).toMatchObject({ command: "usage", success: false });
    if (parsed?.command === "usage") {
      expect(parsed.output).toContain("Unknown learning target");
    }
  });

  test("parses custom env and existing-candidate options", () => {
    const parsed = parseModsCommand(
      "/mods learn --env ./envs/custom.json --candidate ./candidate.ts --skip-generation",
    );

    expect(parsed?.command).toBe("learn");
    if (parsed?.command !== "learn") return;
    expect(parsed.learn.targetLabel).toBe("custom env");
    expect(parsed.learn.env).toBeNull();
    expect(parsed.learn.options.envPath).toBe("./envs/custom.json");
    expect(parsed.learn.options.candidate).toBe("./candidate.ts");
    expect(parsed.learn.options.skipGeneration).toBe(true);
  });

  test("parses multi-candidate learning option", () => {
    const parsed = parseModsCommand(
      "/mods learn memory-citations --candidates 3 --scenario-limit 2 --model auto",
    );

    expect(parsed?.command).toBe("learn");
    if (parsed?.command !== "learn") return;
    expect(parsed.learn.options.candidateCount).toBe(3);
    expect(parsed.learn.options.scenarioLimit).toBe(2);
  });

  test("formats assertion-only perfect-score summaries clearly", () => {
    const cwd = path.resolve("/tmp/letta-mod-command-test");
    const summary = formatModLearningSummary(
      {
        attempts: [
          {
            candidateIndex: 1,
            candidatePath: path.join(cwd, "candidates", "001", "mods", "uv.ts"),
            evalExit: "assertions only",
            generationExit: 0,
            maxScore: 11,
            missingRequiredResultMarkers: [],
            missingRequiredTraceMarkers: [],
            passed: true,
            presentForbiddenResultMarkers: [],
            presentForbiddenTraceMarkers: [],
            reportPath: path.join(cwd, "candidates", "001", "report.md"),
            runDir: path.join(cwd, "candidates", "001"),
            score: 11,
          },
        ],
        candidateCount: 5,
        candidateIndex: 1,
        candidatePath: path.join(cwd, "candidates", "001", "mods", "uv.ts"),
        evalMemoryDir: path.join(cwd, "candidates", "001", "eval"),
        evalResult: null,
        evaluation: {
          assertionChecks: [
            {
              label: "mod-loads",
              message: "loaded",
              passed: true,
            },
          ],
          forbiddenResultMarkers: [],
          forbiddenTraceMarkers: [],
          passed: true,
          requiredResultMarkers: [],
          requiredTraceMarkers: [],
          resultText: "PASS",
          scenarioResults: [
            {
              assertionChecks: [
                {
                  label: "1. mod_loads",
                  message: "loaded",
                  passed: true,
                },
              ],
              evalExit: null,
              evalMemoryDir: path.join(cwd, "candidates", "001", "eval"),
              forbiddenResultMarkers: [],
              forbiddenTraceMarkers: [],
              name: "mod-loads",
              passed: true,
              requiredResultMarkers: [],
              requiredTraceMarkers: [],
              resultText: "PASS",
              timedOut: false,
            },
          ],
        },
        generationResult: null,
        maxScore: 11,
        passed: true,
        promotedToPath: null,
        reportPath: path.join(cwd, "report.md"),
        runDir: cwd,
        score: 11,
        selectedCandidateIndex: 1,
        spec: {
          name: "Use uv instead of pip",
          objective: "Use uv pip install.",
          requirements: [],
          evaluation: { assertions: [{ type: "mod_loads" }] },
        },
        stoppedEarlyAt: 1,
        stoppedEarlyReason: "perfect score",
      },
      cwd,
    );

    expect(summary).toContain(
      "Selected iteration: 1/5 (perfect score; stopped early)",
    );
    expect(summary).toContain("Stopped early: perfect score at iteration 1");
    expect(summary).toContain("Eval: assertions only");
    expect(summary).not.toContain("Eval exit: not run");
  });

  test("runs learning in the background and finishes with report summary", async () => {
    const cwd = path.resolve("/tmp/letta-mod-command-test");
    const { runner, updates } = createFakeCommandRunner();
    let resolveLearning: (() => void) | undefined;
    const learningGate = new Promise<void>((resolve) => {
      resolveLearning = resolve;
    });
    let learningStarted = false;

    const result = handleModsCommand(
      "/mods learn memory-citations --model current --out .letta/test-run",
      {
        commandRunner: runner,
        currentModelId: "openai/gpt-5.5",
        cwd,
        getHeadlessEnv: async () => ({ LETTA_API_KEY: "test-key" }),
        resolveLauncher: () => ({
          command: "letta-test",
          args: ["--from-test"],
        }),
        runLearning: async (options) => {
          learningStarted = true;
          expect(options.cliCommand).toBe("letta-test");
          expect(options.cliArgsPrefix).toEqual(["--from-test"]);
          expect(options.env?.LETTA_API_KEY).toBe("test-key");
          expect(options.generationModel).toBe("openai/gpt-5.5");
          expect(options.evalModel).toBe("openai/gpt-5.5");
          expect(options.runDir).toBe(path.join(cwd, ".letta", "test-run"));
          expect(options.candidateCount).toBe(5);
          expect(options.scenarioLimit).toBeUndefined();
          options.onProgress?.({
            candidateCount: 5,
            candidateIndex: 1,
            candidatePath: path.join(
              cwd,
              ".letta",
              "test-run",
              "candidates",
              "001",
              "mods",
              "memory-citations.ts",
            ),
            message: "Generating optimization iteration 1/5",
            phase: "generating",
            runDir: path.join(cwd, ".letta", "test-run"),
          });
          options.onProgress?.({
            attempts: [
              {
                candidateIndex: 1,
                candidatePath: path.join(
                  cwd,
                  ".letta",
                  "test-run",
                  "mods",
                  "memory-citations.ts",
                ),
                evalExit: "not run",
                generationExit: "skipped",
                missingRequiredResultMarkers: [],
                missingRequiredTraceMarkers: [],
                passed: true,
                presentForbiddenResultMarkers: [],
                presentForbiddenTraceMarkers: [],
                reportPath: path.join(cwd, ".letta", "test-run", "report.md"),
                runDir: path.join(cwd, ".letta", "test-run"),
                maxScore: 6,
                score: 2,
              },
            ],
            candidateCount: 5,
            candidateIndex: 2,
            candidatePath: path.join(
              cwd,
              ".letta",
              "test-run",
              "candidates",
              "002",
              "mods",
              "memory-citations.ts",
            ),
            maxScore: 6,
            message:
              "Evaluating optimization iteration 2/5: scenario 1/7 mod-loads",
            phase: "evaluating",
            runDir: path.join(cwd, ".letta", "test-run"),
            score: 4,
          });
          await learningGate;
          return {
            candidatePath: path.join(
              cwd,
              ".letta",
              "test-run",
              "candidates",
              "002",
              "mods",
              "memory-citations.ts",
            ),
            attempts: [
              {
                candidateIndex: 1,
                candidatePath: path.join(
                  cwd,
                  ".letta",
                  "test-run",
                  "candidates",
                  "001",
                  "mods",
                  "memory-citations.ts",
                ),
                evalExit: "not run",
                generationExit: 0,
                missingRequiredResultMarkers: [],
                missingRequiredTraceMarkers: [],
                passed: false,
                presentForbiddenResultMarkers: [],
                presentForbiddenTraceMarkers: [],
                reportPath: path.join(
                  cwd,
                  ".letta",
                  "test-run",
                  "candidates",
                  "001",
                  "report.md",
                ),
                runDir: path.join(
                  cwd,
                  ".letta",
                  "test-run",
                  "candidates",
                  "001",
                ),
                maxScore: 6,
                score: 2,
              },
              {
                candidateIndex: 2,
                candidatePath: path.join(
                  cwd,
                  ".letta",
                  "test-run",
                  "candidates",
                  "002",
                  "mods",
                  "memory-citations.ts",
                ),
                evalExit: "not run",
                generationExit: 0,
                missingRequiredResultMarkers: [],
                missingRequiredTraceMarkers: [],
                passed: true,
                presentForbiddenResultMarkers: [],
                presentForbiddenTraceMarkers: [],
                reportPath: path.join(
                  cwd,
                  ".letta",
                  "test-run",
                  "candidates",
                  "002",
                  "report.md",
                ),
                runDir: path.join(
                  cwd,
                  ".letta",
                  "test-run",
                  "candidates",
                  "002",
                ),
                maxScore: 6,
                score: 4,
              },
            ],
            candidateCount: 5,
            candidateIndex: 2,
            evalMemoryDir: path.join(cwd, ".letta", "test-run", "eval-memory"),
            evalResult: null,
            evaluation: {
              assertionChecks: [],
              forbiddenResultMarkers: [],
              forbiddenTraceMarkers: [],
              requiredResultMarkers: [],
              requiredTraceMarkers: [],
              resultText: "ok",
              passed: true,
            },
            generationResult: null,
            passed: true,
            promotedToPath: null,
            reportPath: path.join(cwd, ".letta", "test-run", "report.md"),
            runDir: path.join(cwd, ".letta", "test-run"),
            maxScore: 6,
            selectedCandidateIndex: 2,
            score: 4,
            spec: options.spec,
          } satisfies ModLearningReport;
        },
      },
    );

    expect(result.handled).toBe(true);
    for (let tick = 0; tick < 5 && !learningStarted; tick += 1) {
      await Promise.resolve();
    }
    expect(learningStarted).toBe(true);
    expect(updates[0]?.output).toContain(
      "Starting background mod optimization: memory-citations (5 iterations)",
    );
    expect(updates[1]?.output).toContain(
      "Generating optimization iteration 1/5",
    );
    expect(updates[1]?.output).toContain("Optimization progress: ●○○○○ 1/5");
    expect(updates[1]?.output).toContain(
      "Score graph: waiting for first evaluation…",
    );
    expect(updates[1]?.output).toContain("Target mod: memory-citations.ts");
    expect(updates.at(-1)).toMatchObject({ phase: "running" });
    expect(updates.at(-1)?.output).toContain("scenario 1/7 mod-loads");
    expect(updates.at(-1)?.output).toContain(
      "Background mod optimization: memory-citations",
    );
    expect(updates.at(-1)?.output).toMatch(
      /[⠀⠶⠰⣿⠆⢾⣉⡷⣏⣹⡁⢈]+ Background mod optimization/,
    );
    expect(updates.at(-1)?.output).toContain("Optimization iteration: 2/5");
    expect(updates.at(-1)?.output).toContain(
      "Current running score: 4/6 (67%)",
    );
    expect(updates.at(-1)?.output).toContain(
      "Best completed score: 2/6 (33%) at iteration 1",
    );
    expect(updates.at(-1)?.output).toContain(
      "Score history: iter 1 done 2/6 (33%) → iter 2 running 4/6 (67%)",
    );
    expect(updates.at(-1)?.output).toContain(
      "Optimization progress: ●●○○○ 2/5",
    );
    expect(updates.at(-1)?.output).toContain("Score graph: ▁█");
    expect(updates.at(-1)?.output).toContain("iter 1 done       2/6 (33%) │");
    expect(updates.at(-1)?.output).toContain("iter 2 running    4/6 (67%) │");

    resolveLearning?.();
    if (result.handled) await result.done;

    expect(updates.at(-1)).toMatchObject({
      phase: "finished",
      success: true,
    });
    expect(updates.at(-1)?.output).toContain("Finished mod learning");
    expect(updates.at(-1)?.output).toContain("Score: 4/6 (67%)");
    expect(updates.at(-1)?.output).toContain("Score graph: ▁█");
    expect(updates.at(-1)?.output).toContain("did not promote or load");
  });
});
