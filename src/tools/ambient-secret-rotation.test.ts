import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommandHook } from "@/hooks/executor";
import {
  type BackgroundProcess,
  backgroundProcesses,
  scrubCompletedBackgroundOutput,
} from "@/tools/impl/process_manager";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { captureSecretRedactions } from "@/tools/secret-substitution";
import {
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { createTempRuntimeScriptCommand } from "./runtime-script";

const AGENT_A = "agent-secret-substitution-a";
const AMBIENT_SENTINEL = "sk-lettatest-SENTINEL-credential-0123456789abcdef";
const AMBIENT_PLACEHOLDER = "LETTA_API_KEY=<REDACTED>";

function asText(
  toolReturn: Awaited<ReturnType<typeof executeTool>>["toolReturn"],
): string {
  return typeof toolReturn === "string"
    ? toolReturn
    : JSON.stringify(toolReturn);
}

function createHeldCredentialScript(outputPrefixLength = 0): {
  command: string;
  marker: string;
  release: () => void;
  cleanup: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "letta-rotation-test-"));
  const marker = join(directory, "started");
  const releasePath = join(directory, "release");
  const script = createTempRuntimeScriptCommand(`
const fs = require("node:fs");
const credential = process.env.LETTA_API_KEY ?? "";
fs.writeFileSync(${JSON.stringify(marker)}, "started");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
  clearInterval(timer);
  process.stdout.write("x".repeat(${outputPrefixLength}) + credential);
}, 10);
`);
  return {
    command: script.command,
    marker,
    release: () => writeFileSync(releasePath, "go"),
    cleanup: () => {
      script.cleanup();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function waitForMarker(marker: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(existsSync(marker)).toBe(true);
}

describe("ambient runtime credential rotation", () => {
  const originalKey = process.env.LETTA_API_KEY;

  beforeEach(() => {
    process.env.LETTA_API_KEY = AMBIENT_SENTINEL;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.LETTA_API_KEY;
    } else {
      process.env.LETTA_API_KEY = originalKey;
    }
  });

  test("tool return retains the credential captured before rotation", async () => {
    const held = createHeldCredentialScript();
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
      {
        runtimeContext: {
          agentId: AGENT_A,
          workingDirectory: process.cwd(),
        },
        workingDirectory: process.cwd(),
      },
    );
    const execution = executeTool(
      "Bash",
      { command: held.command, timeout: 5000 },
      { toolContextId: prepared.contextId },
    );

    try {
      await waitForMarker(held.marker);
      process.env.LETTA_API_KEY = "sk-lettatest-ROTATED-credential-9876543210";
      held.release();
      const result = await execution;
      const text = asText(result.toolReturn);
      expect(result.status).toBe("success");
      expect(text).not.toContain(AMBIENT_SENTINEL);
      expect(text).toContain(AMBIENT_PLACEHOLDER);
    } finally {
      held.release();
      await execution.catch(() => undefined);
      releaseToolExecutionContext(prepared.contextId);
      held.cleanup();
    }
  }, 10_000);

  for (const toolName of ["Bash", "shell_command"] as const) {
    test(`${toolName} foreground overflow file retains the credential captured before rotation`, async () => {
      const held = createHeldCredentialScript(31_000);
      const prepared = await prepareToolExecutionContextForSpecificTools(
        [toolName],
        {
          runtimeContext: {
            agentId: AGENT_A,
            workingDirectory: process.cwd(),
          },
          workingDirectory: process.cwd(),
        },
      );
      const execution = executeTool(
        toolName,
        toolName === "Bash"
          ? { command: held.command, timeout: 5000 }
          : { command: held.command, login: false, timeout_ms: 5000 },
        { toolContextId: prepared.contextId },
      );

      try {
        await waitForMarker(held.marker);
        process.env.LETTA_API_KEY =
          "sk-lettatest-ROTATED-credential-9876543210";
        held.release();
        const result = await execution;
        const text = asText(result.toolReturn);
        expect(result.status).toBe("success");
        expect(text).not.toContain(AMBIENT_SENTINEL);
        const overflowPath = text.match(
          /\[Full output written to: ([^\]]+)\]/,
        )?.[1];
        expect(overflowPath).toBeDefined();
        if (!overflowPath) throw new Error("Expected overflow file pointer");
        const overflow = readFileSync(overflowPath, "utf8");
        expect(overflow).not.toContain(AMBIENT_SENTINEL);
        expect(overflow).toContain(AMBIENT_PLACEHOLDER);
      } finally {
        held.release();
        await execution.catch(() => undefined);
        releaseToolExecutionContext(prepared.contextId);
        held.cleanup();
      }
    }, 10_000);
  }

  test("background output scrub retains the credential captured before rotation", () => {
    const directory = mkdtempSync(join(tmpdir(), "letta-rotation-file-"));
    const outputFile = join(directory, "output.log");
    const secrets = captureSecretRedactions();
    process.env.LETTA_API_KEY = "sk-lettatest-ROTATED-credential-9876543210";
    writeFileSync(outputFile, `child output: ${AMBIENT_SENTINEL}`);
    const processState: BackgroundProcess = {
      process: { kill: () => undefined },
      command: "test",
      status: "completed",
      exitCode: 0,
      outputFile,
      secrets,
    };
    try {
      expect(scrubCompletedBackgroundOutput(processState)).toBe(true);
      const content = readFileSync(outputFile, "utf8");
      expect(content).not.toContain(AMBIENT_SENTINEL);
      expect(content).toContain(AMBIENT_PLACEHOLDER);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("background command stores and reports a pre-rotation credential safely", async () => {
    const queued: QueuedMessage[] = [];
    setMessageQueueAdder((message) => queued.push(message));
    const held = createHeldCredentialScript();
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
      {
        runtimeContext: {
          agentId: AGENT_A,
          workingDirectory: process.cwd(),
        },
        workingDirectory: process.cwd(),
      },
    );

    try {
      const started = await executeTool(
        "Bash",
        { command: held.command, run_in_background: true, timeout: 5000 },
        { toolContextId: prepared.contextId },
      );
      const bashId = asText(started.toolReturn).match(/bash_\d+/)?.[0];
      expect(bashId).toBeDefined();
      if (!bashId) throw new Error("Expected background Bash id");

      await waitForMarker(held.marker);
      process.env.LETTA_API_KEY = "sk-lettatest-ROTATED-credential-9876543210";
      held.release();
      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          backgroundProcesses.get(bashId)?.status !== "running" &&
          queued.length
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const processState = backgroundProcesses.get(bashId);
      expect(processState?.status).toBe("completed");
      expect(Object.values(processState?.secrets ?? {})).toContain(
        AMBIENT_SENTINEL,
      );
      const outputFile = processState?.outputFile;
      expect(outputFile).toBeDefined();
      if (!outputFile) throw new Error("Expected background output file");
      expect(readFileSync(outputFile, "utf8")).not.toContain(AMBIENT_SENTINEL);
      expect(queued.length).toBeGreaterThan(0);
      for (const message of queued) {
        expect(JSON.stringify(message)).not.toContain(AMBIENT_SENTINEL);
      }
    } finally {
      held.release();
      setMessageQueueAdder(null);
      releaseToolExecutionContext(prepared.contextId);
      held.cleanup();
    }
  }, 10_000);

  test("hook output retains the credential captured before rotation", async () => {
    const held = createHeldCredentialScript();
    const execution = executeCommandHook(
      { type: "command", command: held.command, quiet: true },
      {
        event_type: "SessionStart",
        working_directory: process.cwd(),
        is_new_session: true,
      },
      process.cwd(),
    );
    try {
      await waitForMarker(held.marker);
      process.env.LETTA_API_KEY = "sk-lettatest-ROTATED-credential-9876543210";
      held.release();
      const result = await execution;
      expect(result.stdout).not.toContain(AMBIENT_SENTINEL);
      expect(result.stdout).toContain(AMBIENT_PLACEHOLDER);
    } finally {
      held.release();
      await execution.catch(() => undefined);
      held.cleanup();
    }
  }, 10_000);
});
