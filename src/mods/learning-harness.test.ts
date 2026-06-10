import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandRunner, ModLearningSpec } from "@/mods/learning-harness";
import {
  buildModLearningPrompt,
  evaluateModLearningRun,
  extractHeadlessResultText,
  runModLearning,
} from "@/mods/learning-harness";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "letta-mod-learning-"));
  tempDirs.push(dir);
  return dir;
}

function createSpec(): ModLearningSpec {
  return {
    name: "Memory citation learner",
    objective: "Learn a memory citation mod.",
    requirements: ["Register memory_citation_snapshot", "Cite observed paths"],
    evaluation: {
      memoryFiles: {
        "reference/mod-learning.md": "The code word is CITATION-DOGFOOD-OK.\n",
      },
      outputFormat: "stream-json",
      prompt: "Read $MEMORY_DIR/reference/mod-learning.md and cite it.",
      requiredResultMarkers: [
        "CITATION-DOGFOOD-OK",
        "[[reference/mod-learning.md]]",
      ],
      requiredTraceMarkers: [
        '"name":"memory_citation_snapshot"',
        '"message_type":"tool_return_message"',
      ],
      forbiddenTraceMarkers: ["[mods] failed to load"],
      forbiddenResultMarkers: [
        "memory_citation_snapshot tool is not available",
      ],
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("mod learning harness", () => {
  test("builds a generation prompt with the target file and requirements", () => {
    const spec = createSpec();
    const prompt = buildModLearningPrompt(
      spec,
      "/tmp/run/mods/memory-citations.ts",
    );

    expect(prompt).toContain("/tmp/run/mods/memory-citations.ts");
    expect(prompt).toContain("Register memory_citation_snapshot");
    expect(prompt).toContain("Edit only the candidate file");
    expect(prompt).toContain("letta.tools.register");
  });

  test("builds differentiated prompts for multi-candidate runs", () => {
    const spec = {
      ...createSpec(),
      candidateDiversityHints: ["Use a strict path parser"],
    };
    const prompt = buildModLearningPrompt(
      spec,
      "/tmp/run/candidates/002/mods/memory-citations.ts",
      {
        candidateCount: 3,
        candidateIndex: 2,
        historyPath: "/tmp/run/history.md",
        previousAttemptDirs: ["/tmp/run/candidates/001"],
      },
    );

    expect(prompt).toContain("Candidate attempt: 2 of 3");
    expect(prompt).toContain("Candidate diversity");
    expect(prompt).toContain("// Proposal:");
    expect(prompt).toContain("Use a strict path parser");
    expect(prompt).toContain("/tmp/run/history.md");
  });

  test("extracts result text and evaluates stream-json markers", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_approval",
        tool_call: { name: "memory_citation_snapshot" },
      }),
      JSON.stringify({
        type: "message",
        message_type: "tool_return_message",
        tool_call_id: "tool-call-1",
        status: "success",
        tool_return: "citation snapshot ok",
      }),
      JSON.stringify({
        type: "message",
        message_type: "assistant_message",
        content: "CITATION-DOGFOOD-OK\n\n[[reference/mod-learning.md]]",
      }),
      JSON.stringify({
        type: "result",
        result: "CITATION-DOGFOOD-OK\n\n[[reference/mod-learning.md]]",
      }),
    ].join("\n");

    expect(extractHeadlessResultText(stdout, "stream-json")).toContain(
      "CITATION-DOGFOOD-OK",
    );

    const evaluation = evaluateModLearningRun({
      exitCode: 0,
      outputFormat: "stream-json",
      spec: createSpec().evaluation,
      stdout,
      timedOut: false,
    });

    expect(evaluation.passed).toBe(true);
  });

  test("fails trace evaluation when an approved tool has no return", () => {
    const stdout = [
      JSON.stringify({
        type: "auto_approval",
        tool_call: { name: "memory_citation_snapshot" },
      }),
      JSON.stringify({
        type: "result",
        result: "CITATION-DOGFOOD-OK\n\n[[reference/mod-learning.md]]",
      }),
    ].join("\n");

    const evaluation = evaluateModLearningRun({
      exitCode: 0,
      outputFormat: "stream-json",
      spec: createSpec().evaluation,
      stdout,
      timedOut: false,
    });

    expect(evaluation.passed).toBe(false);
    expect(
      evaluation.requiredTraceMarkers.find((check) =>
        check.marker.includes("tool_return_message"),
      )?.present,
    ).toBe(false);
  });

  test("runs generation, eval, and writes artifacts with a fake command runner", async () => {
    const repoRoot = createTempDir();
    const runDir = path.join(
      repoRoot,
      ".letta",
      "mod-learning-runs",
      "test-run",
    );
    const candidatePath = path.join(runDir, "mods", "memory-citations.ts");
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const progress: string[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ args, env: options.env });
      expect(options.env.LETTA_API_KEY).toBe("test-key");
      if (args.includes("--no-mods")) {
        expect(options.env.LETTA_DISABLE_MODS).toBe("1");
        await mkdir(path.dirname(candidatePath), { recursive: true });
        writeFileSync(
          candidatePath,
          "export function activate(letta) { letta.tools.register({ name: 'memory_citation_snapshot', description: 'snapshot', requiresApproval: false, parallelSafe: true, run() { return '{}'; } }); }\n",
        );
        return {
          args,
          command,
          cwd: options.cwd,
          durationMs: 10,
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ result: "wrote candidate" }),
          timedOut: false,
        };
      }

      expect(options.env.LETTA_MODS_DIR).toBe(path.dirname(candidatePath));
      const memoryDir = options.env.MEMORY_DIR ?? "";
      expect(memoryDir).toBe(path.join(runDir, "eval-memory"));
      const promptArg = args[args.indexOf("-p") + 1] ?? "";
      expect(promptArg).toContain(memoryDir);
      expect(promptArg).not.toContain("$MEMORY_DIR");
      return {
        args,
        command,
        cwd: options.cwd,
        durationMs: 20,
        exitCode: 0,
        stderr: "",
        stdout: [
          JSON.stringify({
            type: "auto_approval",
            tool_call: { name: "memory_citation_snapshot" },
          }),
          JSON.stringify({
            type: "message",
            message_type: "tool_return_message",
            tool_call_id: "tool-call-1",
            status: "success",
            tool_return: "citation snapshot ok",
          }),
          JSON.stringify({
            type: "result",
            result: "CITATION-DOGFOOD-OK\n\n[[reference/mod-learning.md]]",
          }),
        ].join("\n"),
        timedOut: false,
      };
    };

    const report = await runModLearning({
      candidateFileName: "memory-citations.ts",
      commandRunner: runner,
      env: { LETTA_API_KEY: "test-key" },
      onProgress: (event) => progress.push(event.phase),
      repoRoot,
      runDir,
      spec: createSpec(),
    });

    expect(report.passed).toBe(true);
    expect(report.evaluatorKind).toBe("scenario-suite");
    expect(report.selectionScore).toMatchObject({
      kind: "scenario-suite",
      passed: true,
    });
    expect(calls).toHaveLength(2);
    expect(progress).toEqual([
      "preparing",
      "generating",
      "evaluating",
      "writing-report",
      "done",
    ]);
    expect(existsSync(candidatePath)).toBe(true);
    expect(existsSync(path.join(runDir, "generation-prompt.md"))).toBe(true);
    expect(existsSync(path.join(runDir, "eval.stdout"))).toBe(true);
    expect(existsSync(path.join(runDir, "report.md"))).toBe(true);
    expect(
      readFileSync(
        path.join(runDir, "eval-memory", "reference", "mod-learning.md"),
        "utf8",
      ),
    ).toContain("CITATION-DOGFOOD-OK");
  });

  test("runs every configured evaluation scenario", async () => {
    const repoRoot = createTempDir();
    const runDir = path.join(
      repoRoot,
      ".letta",
      "mod-learning-runs",
      "scenarios",
    );
    const candidatePath = path.join(runDir, "mods", "memory-citations.ts");
    const evalMemoryDirs: string[] = [];
    const spec: ModLearningSpec = {
      ...createSpec(),
      evaluation: {
        forbiddenTraceMarkers: ["[mods] failed to load"],
        outputFormat: "stream-json",
        scenarios: [
          {
            memoryFiles: {
              "reference/deploy.md": "Deploy target is CITATION-DOGFOOD-OK.\n",
            },
            name: "implicit-memory-citation",
            prompt: "What is the deploy target? Check memory files.",
            requiredResultMarkers: [
              "CITATION-DOGFOOD-OK",
              "[[reference/deploy.md]]",
            ],
            requiredTraceMarkers: ['"name":"memory_citation_snapshot"'],
          },
          {
            name: "negative-control",
            prompt: "What is 2+2?",
            requiredResultMarkers: ["4"],
            forbiddenResultMarkers: ["[[", "reference/deploy.md"],
          },
        ],
      },
    };
    const runner: CommandRunner = async (command, args, options) => {
      if (args.includes("--no-mods")) {
        await mkdir(path.dirname(candidatePath), { recursive: true });
        writeFileSync(candidatePath, "export function activate() {}\n");
        return {
          args,
          command,
          cwd: options.cwd,
          durationMs: 1,
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ result: "wrote candidate" }),
          timedOut: false,
        };
      }

      evalMemoryDirs.push(options.env.MEMORY_DIR ?? "");
      const isNegativeControl = (options.env.MEMORY_DIR ?? "").includes(
        "negative-control",
      );
      return {
        args,
        command,
        cwd: options.cwd,
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: isNegativeControl
          ? JSON.stringify({ type: "result", result: "4" })
          : [
              JSON.stringify({
                type: "auto_approval",
                tool_call: { name: "memory_citation_snapshot" },
              }),
              JSON.stringify({
                type: "result",
                result: "CITATION-DOGFOOD-OK [[reference/deploy.md]]",
              }),
            ].join("\n"),
        timedOut: false,
      };
    };

    const report = await runModLearning({
      candidateFileName: "memory-citations.ts",
      commandRunner: runner,
      env: {},
      repoRoot,
      runDir,
      spec,
    });

    expect(report.passed).toBe(true);
    expect(
      report.evaluation.scenarioResults?.map((scenario) => scenario.name),
    ).toEqual(["implicit-memory-citation", "negative-control"]);
    expect(evalMemoryDirs).toHaveLength(2);
    expect(
      existsSync(path.join(runDir, "eval", "001-implicit-memory-citation")),
    ).toBe(true);
    expect(existsSync(path.join(runDir, "eval", "002-negative-control"))).toBe(
      true,
    );
  });

  test("runs an outer loop where later candidates see prior attempts", async () => {
    const repoRoot = createTempDir();
    const runDir = path.join(
      repoRoot,
      ".letta",
      "mod-learning-runs",
      "outer-loop",
    );
    const generationPrompts: string[] = [];
    const evalDirs: string[] = [];
    const candidatePathPattern = /Candidate file, absolute path: (.+)/;
    const runner: CommandRunner = async (command, args, options) => {
      const promptArg = args[args.indexOf("-p") + 1] ?? "";
      if (args.includes("--no-mods")) {
        generationPrompts.push(promptArg);
        const candidatePath = candidatePathPattern.exec(promptArg)?.[1];
        if (!candidatePath) throw new Error("Missing candidate path in prompt");
        await mkdir(path.dirname(candidatePath), { recursive: true });
        writeFileSync(
          candidatePath,
          "export function activate(letta) { letta.tools.register({ name: 'memory_citation_snapshot', description: 'snapshot', requiresApproval: false, parallelSafe: true, run() { return '{}'; } }); }\n",
        );
        return {
          args,
          command,
          cwd: options.cwd,
          durationMs: 10,
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ result: "wrote candidate" }),
          timedOut: false,
        };
      }

      evalDirs.push(options.env.LETTA_MODS_DIR ?? "");
      const passing = (options.env.LETTA_MODS_DIR ?? "").includes("002");
      return {
        args,
        command,
        cwd: options.cwd,
        durationMs: 20,
        exitCode: 0,
        stderr: "",
        stdout: [
          JSON.stringify({
            type: "message",
            message_type: "tool_return_message",
            tool_call_id: "tool-call-1",
            status: "success",
            tool_return: "citation snapshot ok",
          }),
          JSON.stringify({
            type: "auto_approval",
            tool_call: { name: "memory_citation_snapshot" },
          }),
          JSON.stringify({
            type: "result",
            result: passing
              ? "CITATION-DOGFOOD-OK\n\n[[reference/mod-learning.md]]"
              : "CITATION-DOGFOOD-OK",
          }),
        ].join("\n"),
        timedOut: false,
      };
    };

    const report = await runModLearning({
      candidateCount: 2,
      candidateFileName: "memory-citations.ts",
      commandRunner: runner,
      env: {},
      repoRoot,
      runDir,
      spec: createSpec(),
    });

    expect(report.passed).toBe(true);
    expect(report.selectedCandidateIndex).toBe(2);
    expect(report.candidatePath).toContain(path.join("candidates", "002"));
    expect(report.attempts?.map((attempt) => attempt.passed)).toEqual([
      false,
      true,
    ]);
    expect(generationPrompts).toHaveLength(2);
    expect(generationPrompts[0]).not.toContain("Prior candidate feedback");
    expect(generationPrompts[1]).toContain("Prior candidate feedback");
    expect(generationPrompts[1]).toContain(path.join(runDir, "history.md"));
    expect(generationPrompts[1]).toContain(
      path.join(runDir, "candidates", "001"),
    );
    expect(evalDirs).toEqual([
      path.join(runDir, "candidates", "001", "mods"),
      path.join(runDir, "candidates", "002", "mods"),
    ]);
    expect(existsSync(path.join(runDir, "history.md"))).toBe(true);
    expect(existsSync(path.join(runDir, "report.md"))).toBe(true);
    expect(readFileSync(path.join(runDir, "history.md"), "utf8")).toContain(
      "Selected candidate: 2",
    );
  });

  test("selects dataset-backed candidates by pass rate then cost", async () => {
    const repoRoot = createTempDir();
    const runDir = path.join(
      repoRoot,
      ".letta",
      "mod-learning-runs",
      "dataset-loop",
    );
    const candidatePathPattern = /Candidate file, absolute path: (.+)/;
    const adapterRequests: string[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      if (args.includes("--no-mods")) {
        const promptArg = args[args.indexOf("-p") + 1] ?? "";
        const candidatePath = candidatePathPattern.exec(promptArg)?.[1];
        if (!candidatePath) throw new Error("Missing candidate path in prompt");
        await mkdir(path.dirname(candidatePath), { recursive: true });
        writeFileSync(candidatePath, "export function activate() {}\n");
        return {
          args,
          command,
          cwd: options.cwd,
          durationMs: 1,
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ result: "wrote candidate" }),
          timedOut: false,
        };
      }

      expect(command).toBe("dataset-adapter");
      expect(options.env.LETTA_MODS_DIR).toBe(options.env.LETTA_EXTENSIONS_DIR);
      const requestPath = args[args.indexOf("--request") + 1] ?? "";
      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      adapterRequests.push(requestPath);
      const candidateIndex = Number(request.candidate.index);
      const costUsd = candidateIndex === 1 ? 1.0 : 0.25;
      return {
        args,
        command,
        cwd: options.cwd,
        durationMs: 2,
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          dataset: "terminalbench",
          passed: true,
          score: { costUsd, passed: 1, passRate: 0.5, total: 2 },
          subset: "smoke",
          summary: `candidate ${candidateIndex}`,
          tasks: [
            {
              costUsd,
              passed: true,
              reportPath: path.join(
                request.artifactsDir,
                "tasks",
                "extract-elf",
                "report.md",
              ),
              taskId: "extract-elf",
            },
            { passed: false, taskId: "other-task" },
          ],
        }),
        timedOut: false,
      };
    };

    const report = await runModLearning({
      candidateCount: 2,
      candidateFileName: "terminalbench-mod.ts",
      commandRunner: runner,
      dataset: {
        adapter: { command: "dataset-adapter" },
        dataset: "terminalbench",
        subset: "smoke",
        taskIds: ["extract-elf"],
        trials: 1,
      },
      env: {},
      repoRoot,
      runDir,
      spec: {
        ...createSpec(),
        name: "TerminalBench learner",
      },
    });

    expect(adapterRequests).toHaveLength(2);
    expect(report.selectedCandidateIndex).toBe(2);
    expect(report.evaluatorKind).toBe("dataset-adapter");
    expect(report.selectionScore).toMatchObject({
      costUsd: 0.25,
      kind: "dataset-adapter",
      passRate: 0.5,
    });
    expect(report.datasetEvaluation?.score).toMatchObject({
      costUsd: 0.25,
      passRate: 0.5,
    });
    expect(report.attempts?.map((attempt) => attempt.datasetCostUsd)).toEqual([
      1, 0.25,
    ]);
    expect(readFileSync(path.join(runDir, "history.md"), "utf8")).toContain(
      "Dataset pass rate: 1/2 (50.0%)",
    );
    expect(readFileSync(path.join(runDir, "report.md"), "utf8")).toContain(
      "## Dataset evaluation",
    );
    expect(readFileSync(path.join(runDir, "report.md"), "utf8")).toContain(
      "- Status: SCORED",
    );
  });
});
