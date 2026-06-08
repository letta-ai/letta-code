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
import type {
  CommandRunner,
  ExtensionLearningSpec,
} from "@/extensions/learning-harness";
import {
  buildExtensionLearningPrompt,
  evaluateExtensionLearningRun,
  extractHeadlessResultText,
  runExtensionLearning,
} from "@/extensions/learning-harness";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "letta-extension-lab-"));
  tempDirs.push(dir);
  return dir;
}

function createSpec(): ExtensionLearningSpec {
  return {
    name: "Memory citation learner",
    objective: "Learn a memory citation extension.",
    requirements: ["Register memory_citation_snapshot", "Cite observed paths"],
    evaluation: {
      memoryFiles: {
        "reference/extension-lab.md": "The code word is CITATION-DOGFOOD-OK.\n",
      },
      outputFormat: "stream-json",
      prompt: "Read $MEMORY_DIR/reference/extension-lab.md and cite it.",
      requiredResultMarkers: [
        "CITATION-DOGFOOD-OK",
        "Memory references:",
        "reference/extension-lab.md",
      ],
      requiredTraceMarkers: [
        '"name":"memory_citation_snapshot"',
        '"message_type":"tool_return_message"',
      ],
      forbiddenTraceMarkers: ["[extensions] failed to load"],
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

describe("extension learning harness", () => {
  test("builds a generation prompt with the target file and requirements", () => {
    const spec = createSpec();
    const prompt = buildExtensionLearningPrompt(
      spec,
      "/tmp/run/extensions/memory-citations.ts",
    );

    expect(prompt).toContain("/tmp/run/extensions/memory-citations.ts");
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
          "CITATION-DOGFOOD-OK\n\nMemory references: reference/extension-lab.md",
      }),
      JSON.stringify({
        type: "result",
        result:
          "CITATION-DOGFOOD-OK\n\nMemory references: reference/extension-lab.md",
      }),
    ].join("\n");

    expect(extractHeadlessResultText(stdout, "stream-json")).toContain(
      "CITATION-DOGFOOD-OK",
    );

    const evaluation = evaluateExtensionLearningRun({
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
          "CITATION-DOGFOOD-OK\n\nMemory references: reference/extension-lab.md",
      }),
    ].join("\n");

    const evaluation = evaluateExtensionLearningRun({
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
      "extension-lab-runs",
      "test-run",
    );
    const candidatePath = path.join(
      runDir,
      "extensions",
      "memory-citations.ts",
    );
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ args, env: options.env });
      if (args.includes("--no-extensions")) {
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

      expect(options.env.LETTA_EXTENSIONS_DIR).toBe(
        path.dirname(candidatePath),
      );
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
              "CITATION-DOGFOOD-OK\n\nMemory references: reference/extension-lab.md",
          }),
        ].join("\n"),
        timedOut: false,
      };
    };

    const report = await runExtensionLearning({
      candidateFileName: "memory-citations.ts",
      commandRunner: runner,
      repoRoot,
      runDir,
      spec: createSpec(),
    });

    expect(report.passed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(existsSync(candidatePath)).toBe(true);
    expect(existsSync(path.join(runDir, "generation-prompt.md"))).toBe(true);
    expect(existsSync(path.join(runDir, "eval.stdout"))).toBe(true);
    expect(existsSync(path.join(runDir, "report.md"))).toBe(true);
    expect(
      readFileSync(
        path.join(runDir, "eval-memory", "reference", "extension-lab.md"),
        "utf8",
      ),
    ).toContain("CITATION-DOGFOOD-OK");
  });
});
