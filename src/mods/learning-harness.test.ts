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
  const dir = mkdtempSync(path.join(tmpdir(), "letta-mod-lab-"));
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
        "reference/mod-lab.md": "The code word is CITATION-DOGFOOD-OK.\n",
      },
      outputFormat: "stream-json",
      prompt: "Read $MEMORY_DIR/reference/mod-lab.md and cite it.",
      requiredResultMarkers: [
        "CITATION-DOGFOOD-OK",
        "Memory references:",
        "reference/mod-lab.md",
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
        content:
          "CITATION-DOGFOOD-OK\n\nMemory references: reference/mod-lab.md",
      }),
      JSON.stringify({
        type: "result",
        result:
          "CITATION-DOGFOOD-OK\n\nMemory references: reference/mod-lab.md",
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
        result:
          "CITATION-DOGFOOD-OK\n\nMemory references: reference/mod-lab.md",
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
    const runDir = path.join(repoRoot, ".letta", "mod-lab-runs", "test-run");
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
      expect(options.env.MEMORY_DIR).toBe(path.join(runDir, "eval-memory"));
      const promptArg = args[args.indexOf("-p") + 1];
      expect(promptArg).toContain(options.env.MEMORY_DIR);
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
            result:
              "CITATION-DOGFOOD-OK\n\nMemory references: reference/mod-lab.md",
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
      "writing-report",
      "done",
    ]);
    expect(existsSync(candidatePath)).toBe(true);
    expect(existsSync(path.join(runDir, "generation-prompt.md"))).toBe(true);
    expect(existsSync(path.join(runDir, "eval.stdout"))).toBe(true);
    expect(existsSync(path.join(runDir, "report.md"))).toBe(true);
    expect(
      readFileSync(
        path.join(runDir, "eval-memory", "reference", "mod-lab.md"),
        "utf8",
      ),
    ).toContain("CITATION-DOGFOOD-OK");
  });
});
