import { afterEach, describe, expect, test } from "bun:test";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import { __testSetBackend, type Backend } from "@/backend";
import { isRetriableError } from "@/cli/app/retry";

const capabilities = {
  remoteMemfs: false,
  serverSideToolManagement: false,
  serverSecrets: false,
  agentFileImportExport: false,
  promptRecompile: false,
  byokProviderRefresh: false,
  localModelCatalog: true,
  localMemfs: false,
};

function setRunErrorMetadata(error: unknown): void {
  __testSetBackend({
    capabilities,
    async retrieveRun(runId: string) {
      return {
        id: runId,
        metadata: { error },
      };
    },
  } as unknown as Backend);
}

afterEach(() => {
  __testSetBackend(null);
});

describe("post-stream retry classification", () => {
  test("honors explicit retryable local run metadata", async () => {
    setRunErrorMetadata({
      error_type: "llm_error",
      detail: "HTTP 503: provider overloaded",
      retryable: true,
    });

    await expect(
      isRetriableError("error" as StopReasonType, "local-run-1"),
    ).resolves.toBe(true);
  });

  test("honors explicit non-retryable local run metadata", async () => {
    setRunErrorMetadata({
      error_type: "llm_error",
      detail: "Authentication error",
      retryable: false,
    });

    await expect(
      isRetriableError("error" as StopReasonType, "local-run-1"),
    ).resolves.toBe(false);
  });

  test("does not retry llm_api_error when run metadata says auth is non-retryable", async () => {
    setRunErrorMetadata({
      error_type: "llm_authentication",
      detail:
        "Z.ai Chat Completions API stream failed (401): Authentication Failed",
      retryable: false,
    });

    await expect(
      isRetriableError("llm_api_error" as StopReasonType, "local-run-1"),
    ).resolves.toBe(false);
  });
});
