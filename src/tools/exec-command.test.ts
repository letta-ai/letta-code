import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  __clearExecSessionsForTests,
  exec_command,
  write_stdin,
} from "@/tools/impl/exec-command";
import {
  __resetBackgroundRetentionConfigForTests,
  backgroundProcesses,
} from "@/tools/impl/process_manager";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("Codex unified exec tools", () => {
  beforeEach(() => {
    __resetBackgroundRetentionConfigForTests();
  });

  afterEach(() => {
    const outputFiles = Array.from(backgroundProcesses.values())
      .map((proc) => proc.outputFile)
      .filter((filePath): filePath is string => Boolean(filePath));

    for (const proc of backgroundProcesses.values()) {
      try {
        proc.process.kill("SIGTERM");
      } catch {
        // Ignore cleanup failures for already-exited processes.
      }
    }
    backgroundProcesses.clear();
    __clearExecSessionsForTests();
    __resetBackgroundRetentionConfigForTests();

    for (const outputFile of outputFiles) {
      if (fs.existsSync(outputFile)) {
        fs.unlinkSync(outputFile);
      }
    }
  });

  test("formats completed command output like Codex unified exec", async () => {
    const result = await exec_command({ cmd: "printf 'hello'" });

    expect(result.output).toMatch(/Chunk ID: [0-9a-f]{6}/);
    expect(result.output).toContain("Wall time:");
    expect(result.output).toContain("Process exited with code 0");
    expect(result.output).toContain("Original token count:");
    expect(result.output).toContain("Output:\nhello");
    expect(result.output).not.toContain("Process running with session ID");
  });

  test("returns session id for running command and write_stdin polls it", async () => {
    const first = await exec_command({
      cmd: "printf start; sleep 0.2; printf done",
      yield_time_ms: 50,
    });

    const match = first.output.match(/Process running with session ID (\d+)/);
    expect(match?.[1]).toBeDefined();
    expect(first.output).toContain("Output:\nstart");

    const second = await write_stdin({
      session_id: Number(match?.[1]),
      chars: "",
      yield_time_ms: 500,
    });

    expect(second.output).toContain("Process exited with code 0");
    expect(second.output).toContain("Output:\ndone");
  });

  test("write_stdin sends input to tty-enabled sessions", async () => {
    const first = await exec_command({
      cmd: "cat",
      tty: true,
      yield_time_ms: 50,
    });

    const match = first.output.match(/Process running with session ID (\d+)/);
    expect(match?.[1]).toBeDefined();

    const second = await write_stdin({
      session_id: Number(match?.[1]),
      chars: "hello\n",
      yield_time_ms: 200,
    });

    expect(second.output).toContain("Process running with session ID");
    expect(second.output).toContain("Output:\nhello");
  });

  test("preserves non-zero exit code in model-facing output", async () => {
    const result = await exec_command({
      cmd: "printf 'bad'; exit 7",
      yield_time_ms: 50,
    });

    expect(result.output).toContain("Process exited with code 7");
    expect(result.output).toContain("Output:\nbad");
  });
});
