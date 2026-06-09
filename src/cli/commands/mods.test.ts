import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { CommandHandle, CommandUpdate } from "@/cli/commands/runner";
import type { ModLearningReport } from "@/mods/learning-harness";
import { handleModsCommand, parseModsCommand } from "./mods";

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
    expect(parsed.learn.spec?.name).toContain("Memory citation");
  });

  test("rejects unknown learning targets", () => {
    const parsed = parseModsCommand("/mods learn unknown-target");
    expect(parsed).toMatchObject({ command: "usage", success: false });
    if (parsed?.command === "usage") {
      expect(parsed.output).toContain("Unknown learning target");
    }
  });

  test("parses custom spec and existing-candidate options", () => {
    const parsed = parseModsCommand(
      "/mods learn --spec ./specs/custom.json --candidate ./candidate.ts --skip-generation",
    );

    expect(parsed?.command).toBe("learn");
    if (parsed?.command !== "learn") return;
    expect(parsed.learn.targetLabel).toBe("custom spec");
    expect(parsed.learn.spec).toBeNull();
    expect(parsed.learn.options.specPath).toBe("./specs/custom.json");
    expect(parsed.learn.options.candidate).toBe("./candidate.ts");
    expect(parsed.learn.options.skipGeneration).toBe(true);
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
          options.onProgress?.({
            candidatePath: path.join(
              cwd,
              ".letta",
              "test-run",
              "mods",
              "memory-citations.ts",
            ),
            message: "Generating candidate mod",
            phase: "generating",
            runDir: path.join(cwd, ".letta", "test-run"),
          });
          await learningGate;
          return {
            candidatePath: path.join(
              cwd,
              ".letta",
              "test-run",
              "mods",
              "memory-citations.ts",
            ),
            evalMemoryDir: path.join(cwd, ".letta", "test-run", "eval-memory"),
            evalResult: null,
            evaluation: {
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
    expect(updates.at(-1)).toMatchObject({ phase: "running" });
    expect(updates.at(-1)?.output).toContain("Generating candidate mod");

    resolveLearning?.();
    if (result.handled) await result.done;

    expect(updates.at(-1)).toMatchObject({
      phase: "finished",
      success: true,
    });
    expect(updates.at(-1)?.output).toContain("PASS Mod Lab");
    expect(updates.at(-1)?.output).toContain("did not promote or load");
  });
});
