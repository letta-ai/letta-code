import { afterEach, describe, expect, test } from "bun:test";
import { __testSetBackend, type Backend } from "@/backend";
import { isRetriablePostStopError } from "@/websocket/listener/recovery";

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

describe("websocket post-stop retry fallback", () => {
  test("retries formatted Cloudflare 521 detail without a run id", async () => {
    const detail =
      "Cloudflare 521: Web server is down for api.letta.com (Ray ID: 9e829917ee973824). This is usually a temporary edge/origin outage. Please retry in a moment.";

    await expect(isRetriablePostStopError("error", null, detail)).resolves.toBe(
      true,
    );
  });

  test("honors explicit retryable run metadata", async () => {
    setRunErrorMetadata({
      error_type: "internal_error",
      detail: "Authentication error",
      retryable: true,
    });

    await expect(isRetriablePostStopError("error", "run-1")).resolves.toBe(
      true,
    );
  });

  test("honors explicit non-retryable run metadata", async () => {
    setRunErrorMetadata({
      error_type: "llm_error",
      detail: "HTTP 503: provider overloaded",
      retryable: false,
    });

    await expect(isRetriablePostStopError("error", "run-1")).resolves.toBe(
      false,
    );
  });

  test("does not retry llm_api_error when run metadata says auth is non-retryable", async () => {
    setRunErrorMetadata({
      error_type: "llm_authentication",
      detail:
        "Z.ai Chat Completions API stream failed (401): Authentication Failed",
      retryable: false,
    });

    await expect(
      isRetriablePostStopError("llm_api_error", "run-1"),
    ).resolves.toBe(false);
  });
});
