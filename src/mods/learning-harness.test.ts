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
        historyManifestPath: "/tmp/run/history.json",
        historyPath: "/tmp/run/history.md",
        proposerGuidePath: "/tmp/run/proposer-guide.md",
        previousAttemptDirs: ["/tmp/run/candidates/001"],
      },
    );

    expect(prompt).toContain("Optimization iteration: 2 of 3");
    expect(prompt).toContain("Candidate diversity");
    expect(prompt).toContain("// Proposal:");
    expect(prompt).toContain("Use a strict path parser");
    expect(prompt).toContain("/tmp/run/proposer-guide.md");
    expect(prompt).toContain("/tmp/run/history.json");
    expect(prompt).toContain("/tmp/run/history.md");
    expect(prompt).toContain("manifest.json");
    expect(prompt).toContain("rg");
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
    expect(calls).toHaveLength(2);
    expect(progress).toEqual([
      "preparing",
      "generating",
      "evaluating",
      "evaluating",
      "writing-report",
      "done",
    ]);
    expect(existsSync(candidatePath)).toBe(true);
    expect(existsSync(path.join(runDir, "generation-prompt.md"))).toBe(true);
    expect(existsSync(path.join(runDir, "eval.stdout"))).toBe(true);
    expect(existsSync(path.join(runDir, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(runDir, "history.json"))).toBe(true);
    expect(existsSync(path.join(runDir, "proposer-guide.md"))).toBe(true);
    expect(existsSync(path.join(runDir, "report.md"))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(path.join(runDir, "manifest.json"), "utf8"),
    ) as {
      artifacts: {
        candidatePath: string;
        generationPromptPath?: string;
        reportJsonPath: string;
      };
      kind: string;
    };
    expect(manifest.kind).toBe("mod_learning_candidate_manifest");
    expect(manifest.artifacts.candidatePath).toBe(candidatePath);
    expect(manifest.artifacts.generationPromptPath).toBe(
      path.join(runDir, "generation-prompt.md"),
    );
    expect(manifest.artifacts.reportJsonPath).toBe(
      path.join(runDir, "report.json"),
    );
    const historyManifest = JSON.parse(
      readFileSync(path.join(runDir, "history.json"), "utf8"),
    ) as { attemptCount: number; attempts: Array<{ manifestPath: string }> };
    expect(historyManifest.attemptCount).toBe(1);
    expect(historyManifest.attempts[0]?.manifestPath).toBe(
      path.join(runDir, "manifest.json"),
    );
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
    const progress: Array<{ message: string; score?: number }> = [];

    const report = await runModLearning({
      candidateFileName: "memory-citations.ts",
      commandRunner: runner,
      env: {},
      onProgress: (update) => {
        progress.push({ message: update.message, score: update.score });
      },
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
    expect(progress).toContainEqual({
      message:
        "Evaluating candidate mod: scenario 1/2 implicit-memory-citation",
      score: 4,
    });
    expect(progress).toContainEqual({
      message: "Evaluating candidate mod: scenario 2/2 negative-control",
      score: 8,
    });
  });

  test("limits scenarios in smoke evals and generation prompts", async () => {
    const repoRoot = createTempDir();
    const runDir = path.join(repoRoot, ".letta", "mod-learning-runs", "smoke");
    const candidatePath = path.join(runDir, "mods", "memory-citations.ts");
    let generationPrompt = "";
    const spec: ModLearningSpec = {
      ...createSpec(),
      evaluation: {
        scenarios: [
          {
            assertions: [{ type: "mod_loads", expectedLoadedCount: 1 }],
            name: "mod-loads",
          },
          {
            assertions: [
              {
                contains: ["cite", "memory"],
                type: "turn_start_injects_message",
              },
            ],
            name: "turn-start-reminder",
          },
        ],
      },
    };
    const runner: CommandRunner = async (command, args, options) => {
      generationPrompt = args[args.indexOf("-p") + 1] ?? "";
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
    };

    const report = await runModLearning({
      candidateFileName: "memory-citations.ts",
      commandRunner: runner,
      env: {},
      repoRoot,
      runDir,
      scenarioLimit: 1,
      spec,
    });

    expect(generationPrompt).toContain("mod_loads");
    expect(generationPrompt).not.toContain("turn_start_injects_message");
    expect(
      report.evaluation.scenarioResults?.map((scenario) => scenario.name),
    ).toEqual(["mod-loads"]);
    expect(report.maxScore).toBe(1);
  });

  test("runs executable mod assertions without a headless marker run", async () => {
    const repoRoot = createTempDir();
    const runDir = path.join(
      repoRoot,
      ".letta",
      "mod-learning-runs",
      "assertions",
    );
    const sourcePath = path.join(repoRoot, "uv-pip-install.ts");
    writeFileSync(
      sourcePath,
      `export function activate(letta) {
        const disposers = [];
        if (letta.capabilities.events.turns) {
          disposers.push(letta.events.on("turn_start", (event) => ({
            input: [
              ...event.input,
              {
                type: "message",
                role: "system",
                content: "For Python packages, use uv pip install instead of pip install.",
              },
            ],
          })));
        }
        if (letta.capabilities.events.tools) {
          const rewrite = (command) => command
            .replace(/^python3? -m pip install\\b/, "uv pip install")
            .replace(/^pip install\\b/, "uv pip install");
          disposers.push(letta.events.on("tool_start", (event) => {
            if (typeof event.args.command === "string") {
              return { args: { ...event.args, command: rewrite(event.args.command) } };
            }
            if (typeof event.args.cmd === "string") {
              return { args: { ...event.args, cmd: rewrite(event.args.cmd) } };
            }
          }));
        }
        return () => disposers.reverse().forEach((dispose) => dispose());
      }
      `,
    );
    const runner: CommandRunner = async () => {
      throw new Error("assertion-only eval should not spawn headless runs");
    };
    const spec: ModLearningSpec = {
      name: "uv pip assertion eval",
      objective: "Verify uv pip mod behavior directly.",
      requirements: ["Inject a reminder", "Rewrite pip tool args"],
      targetModName: "uv-pip-install.ts",
      evaluation: {
        scenarios: [
          {
            assertions: [{ type: "mod_loads", expectedLoadedCount: 1 }],
            name: "mod-loads",
          },
          {
            assertions: [
              {
                type: "turn_start_injects_message",
                contains: ["uv pip install", "pip install"],
              },
            ],
            name: "turn-start-reminder",
          },
          {
            assertions: [
              {
                args: { command: "pip install --dry-run requests" },
                expectArgs: {
                  command: "uv pip install --dry-run requests",
                },
                toolName: "Bash",
                type: "tool_start_rewrites_args",
              },
              {
                args: {
                  cmd: "python -m pip install --dry-run --upgrade numpy",
                },
                expectArgs: {
                  cmd: "uv pip install --dry-run --upgrade numpy",
                },
                toolName: "exec_command",
                type: "tool_start_rewrites_args",
              },
              {
                args: { command: "npm install lodash" },
                toolName: "Bash",
                type: "tool_start_preserves_args",
              },
            ],
            name: "tool-start-args",
          },
        ],
      },
    };

    const report = await runModLearning({
      candidateFileName: "uv-pip-install.ts",
      candidateSourcePath: "uv-pip-install.ts",
      commandRunner: runner,
      env: {},
      repoRoot,
      runDir,
      spec,
    });

    expect(report.passed).toBe(true);
    expect(report.evalResult).toBeNull();
    expect(report.evaluation.assertionChecks).toHaveLength(5);
    expect(
      report.evaluation.assertionChecks.every((check) => check.passed),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          runDir,
          "eval",
          "003-tool-start-args",
          "assertions.result.json",
        ),
      ),
    ).toBe(true);
    expect(readFileSync(path.join(runDir, "report.md"), "utf8")).toContain(
      "Assertion checks",
    );
    expect(readFileSync(path.join(runDir, "report.md"), "utf8")).toContain(
      "- Eval: assertions only",
    );
  });

  test("stops multi-iteration learning after a perfect score", async () => {
    const repoRoot = createTempDir();
    const runDir = path.join(
      repoRoot,
      ".letta",
      "mod-learning-runs",
      "early-stop",
    );
    let generationCount = 0;
    const candidatePathPattern = /Candidate file, absolute path: (.+)/;
    const runner: CommandRunner = async (command, args, options) => {
      generationCount += 1;
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
    };

    const report = await runModLearning({
      candidateCount: 3,
      candidateFileName: "perfect.ts",
      commandRunner: runner,
      env: {},
      repoRoot,
      runDir,
      spec: {
        name: "perfect assertion env",
        objective: "Stop once the assertion passes.",
        requirements: ["Load cleanly"],
        evaluation: {
          scenarios: [
            {
              assertions: [{ type: "mod_loads", expectedLoadedCount: 1 }],
              name: "mod-loads",
            },
          ],
        },
      },
    });

    expect(generationCount).toBe(1);
    expect(report.attempts).toHaveLength(1);
    expect(report.stoppedEarlyAt).toBe(1);
    expect(report.stoppedEarlyReason).toBe("perfect score");
    expect(report.score).toBe(report.maxScore);
    expect(readFileSync(path.join(runDir, "report.md"), "utf8")).toContain(
      "Candidate attempts: 1/3 (stopped early: perfect score)",
    );
  });

  test("fails executable assertions when tool args are not rewritten", async () => {
    const repoRoot = createTempDir();
    const runDir = path.join(
      repoRoot,
      ".letta",
      "mod-learning-runs",
      "assertion-failure",
    );
    writeFileSync(
      path.join(repoRoot, "noop.ts"),
      "export function activate() {}\n",
    );
    const spec: ModLearningSpec = {
      name: "failing assertion eval",
      objective: "Verify assertion failures are real.",
      requirements: ["Rewrite pip tool args"],
      targetModName: "noop.ts",
      evaluation: {
        scenarios: [
          {
            assertions: [
              {
                args: { command: "pip install requests" },
                expectArgs: { command: "uv pip install requests" },
                toolName: "Bash",
                type: "tool_start_rewrites_args",
              },
            ],
            name: "tool-start-args",
          },
        ],
      },
    };

    const report = await runModLearning({
      candidateFileName: "noop.ts",
      candidateSourcePath: "noop.ts",
      commandRunner: async () => {
        throw new Error("assertion-only eval should not spawn headless runs");
      },
      env: {},
      repoRoot,
      runDir,
      spec,
    });

    expect(report.passed).toBe(false);
    expect(report.evaluation.assertionChecks).toHaveLength(1);
    expect(report.evaluation.assertionChecks[0]?.passed).toBe(false);
    expect(report.evaluation.assertionChecks[0]?.details?.actualArgs).toEqual({
      command: "pip install requests",
    });
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
    const progress: Array<{
      attempts?: number;
      candidateIndex?: number;
      message: string;
      score?: number;
    }> = [];
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
      onProgress: (update) => {
        progress.push({
          attempts: update.attempts?.length,
          candidateIndex: update.candidateIndex,
          message: update.message,
          score: update.score,
        });
      },
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
    expect(generationPrompts[1]).toContain(
      path.join(runDir, "proposer-guide.md"),
    );
    expect(generationPrompts[1]).toContain(path.join(runDir, "history.json"));
    expect(generationPrompts[1]).toContain(path.join(runDir, "history.md"));
    expect(generationPrompts[1]).toContain("manifest.json");
    expect(generationPrompts[1]).toContain(
      path.join(runDir, "candidates", "001"),
    );
    expect(evalDirs).toEqual([
      path.join(runDir, "candidates", "001", "mods"),
      path.join(runDir, "candidates", "002", "mods"),
    ]);
    expect(progress).toContainEqual({
      attempts: 1,
      candidateIndex: 2,
      message: "Generating optimization iteration 2/2",
      score: undefined,
    });
    expect(existsSync(path.join(runDir, "history.md"))).toBe(true);
    expect(existsSync(path.join(runDir, "history.json"))).toBe(true);
    expect(existsSync(path.join(runDir, "proposer-guide.md"))).toBe(true);
    expect(
      existsSync(path.join(runDir, "candidates", "001", "manifest.json")),
    ).toBe(true);
    expect(
      existsSync(path.join(runDir, "candidates", "002", "manifest.json")),
    ).toBe(true);
    expect(existsSync(path.join(runDir, "report.md"))).toBe(true);
    const historyManifest = JSON.parse(
      readFileSync(path.join(runDir, "history.json"), "utf8"),
    ) as {
      attemptCount: number;
      attempts: Array<{
        candidateIndex: number;
        manifestPath: string;
        reportJsonPath: string;
      }>;
      proposerGuidePath: string;
      selectedCandidateIndex?: number;
    };
    expect(historyManifest.attemptCount).toBe(2);
    expect(historyManifest.selectedCandidateIndex).toBe(2);
    expect(historyManifest.proposerGuidePath).toBe(
      path.join(runDir, "proposer-guide.md"),
    );
    expect(
      historyManifest.attempts.map((attempt) => attempt.candidateIndex),
    ).toEqual([1, 2]);
    expect(historyManifest.attempts[0]?.manifestPath).toBe(
      path.join(runDir, "candidates", "001", "manifest.json"),
    );
    const firstCandidateManifest = JSON.parse(
      readFileSync(
        path.join(runDir, "candidates", "001", "manifest.json"),
        "utf8",
      ),
    ) as {
      artifacts: {
        candidatePath: string;
        evalDir: string;
        generationPromptPath?: string;
        reportMarkdownPath: string;
      };
      kind: string;
    };
    expect(firstCandidateManifest.kind).toBe("mod_learning_candidate_manifest");
    expect(firstCandidateManifest.artifacts.candidatePath).toBe(
      path.join(runDir, "candidates", "001", "mods", "memory-citations.ts"),
    );
    expect(firstCandidateManifest.artifacts.generationPromptPath).toBe(
      path.join(runDir, "candidates", "001", "generation-prompt.md"),
    );
    expect(firstCandidateManifest.artifacts.reportMarkdownPath).toBe(
      path.join(runDir, "candidates", "001", "report.md"),
    );
    expect(readFileSync(path.join(runDir, "history.md"), "utf8")).toContain(
      "Selected candidate: 2",
    );
    expect(
      readFileSync(path.join(runDir, "proposer-guide.md"), "utf8"),
    ).toContain("eval/**/eval.stdout");
  });
});
