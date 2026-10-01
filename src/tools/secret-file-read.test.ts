import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
  type ToolReturnContent,
} from "@/tools/manager";
import { clearReferencedShortSecrets } from "@/tools/secret-substitution";
import {
  __testSeedSecretsCache,
  clearSecretsCache,
} from "@/utils/secrets-store";

const TEST_AGENT_ID = "agent-secret-file-read";
const LONG_NAME = "VAULT_TOKEN";
const LONG_SECRET = "vault-exfil-test-value-9f3c";
const SHORT_NAME = "PIN";
const SHORT_SECRET = "he$$o";
const UNUSED_NAME = "PROFILE";
const UNUSED_SECRET = "letta";

function toolReturnText(toolReturn: ToolReturnContent): string {
  return typeof toolReturn === "string"
    ? toolReturn
    : toolReturn
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
}

function writeReferencedSecretCommand(name: string, filePath: string): string {
  return process.platform === "win32"
    ? `Set-Content -NoNewline -Path '${filePath}' -Value $${name}`
    : `printf '%s' "$${name}" > '${filePath}'`;
}

afterEach(() => {
  clearSecretsCache(TEST_AGENT_ID);
  clearReferencedShortSecrets(TEST_AGENT_ID);
});

describe("agent secret file reads", () => {
  test("Read redacts a vault secret that was written to disk", async () => {
    __testSeedSecretsCache(TEST_AGENT_ID, { [LONG_NAME]: LONG_SECRET });
    const dir = mkdtempSync(join(tmpdir(), "letta-secret-read-"));
    const filePath = join(dir, "leaked.txt");
    writeFileSync(filePath, `${LONG_SECRET}\n`);
    const context = await prepareToolExecutionContextForSpecificTools(
      ["Read"],
      {
        runtimeContext: { agentId: TEST_AGENT_ID, workingDirectory: dir },
        workingDirectory: dir,
      },
    );

    try {
      const result = await executeTool(
        "Read",
        { file_path: filePath },
        { toolContextId: context.contextId },
      );
      const output = toolReturnText(result.toolReturn);

      expect(result.status).toBe("success");
      expect(output).not.toContain(LONG_SECRET);
      expect(output).toContain(`${LONG_NAME}=<REDACTED>`);
    } finally {
      releaseToolExecutionContext(context.contextId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Read redacts a short secret after the shell referenced it", async () => {
    __testSeedSecretsCache(TEST_AGENT_ID, { [SHORT_NAME]: SHORT_SECRET });
    const dir = mkdtempSync(join(tmpdir(), "letta-secret-echo-"));
    const filePath = join(dir, "pin.txt");
    const context = await prepareToolExecutionContextForSpecificTools(
      ["Bash", "Read"],
      {
        runtimeContext: { agentId: TEST_AGENT_ID, workingDirectory: dir },
        workingDirectory: dir,
      },
    );

    try {
      const wrote = await executeTool(
        "Bash",
        {
          command: writeReferencedSecretCommand(SHORT_NAME, filePath),
          description: "Write referenced secret to a file",
        },
        { toolContextId: context.contextId },
      );
      expect(wrote.status).toBe("success");
      expect(toolReturnText(wrote.toolReturn)).not.toContain(SHORT_SECRET);

      const result = await executeTool(
        "Read",
        { file_path: filePath },
        { toolContextId: context.contextId },
      );
      const output = toolReturnText(result.toolReturn);

      expect(result.status).toBe("success");
      expect(output).not.toContain(SHORT_SECRET);
      expect(output).toContain(`${SHORT_NAME}=<REDACTED>`);
    } finally {
      releaseToolExecutionContext(context.contextId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not redact an unused low-entropy secret from a file read", async () => {
    __testSeedSecretsCache(TEST_AGENT_ID, { [UNUSED_NAME]: UNUSED_SECRET });
    const dir = mkdtempSync(join(tmpdir(), "letta-secret-unused-"));
    const filePath = join(dir, "ordinary.txt");
    writeFileSync(filePath, `${UNUSED_SECRET}\n`);
    const context = await prepareToolExecutionContextForSpecificTools(
      ["Read"],
      {
        runtimeContext: { agentId: TEST_AGENT_ID, workingDirectory: dir },
        workingDirectory: dir,
      },
    );

    try {
      const result = await executeTool(
        "Read",
        { file_path: filePath },
        { toolContextId: context.contextId },
      );
      const output = toolReturnText(result.toolReturn);

      expect(result.status).toBe("success");
      expect(output).toContain(UNUSED_SECRET);
      expect(output).not.toContain(`${UNUSED_NAME}=<REDACTED>`);
    } finally {
      releaseToolExecutionContext(context.contextId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
